import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { providers, requests, year, month } = req.body;

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = new Date(year, month, 1).toLocaleString("default", { month: "long" });

  const providerEmailMap = {};
  for (const p of providers) providerEmailMap[p.id] = p.email;

  const approvedRequests = requests.filter(r => r.status === "Approved").map(r => ({
    ...r,
    email: r.providers?.email || providerEmailMap[r.provider_id] || null,
    name: r.providers?.name || providers.find(p => p.id === r.provider_id)?.name || "Unknown",
  })).filter(r => r.email);

  // ── Fetch full history directly from DB ───────────────────────────────────
  const thisMonthStart = `${year}-${String(month+1).padStart(2,"0")}-01`;
  const { data: historyRows } = await supabase
    .from("call_schedule")
    .select("date, providers(email)")
    .lt("date", thisMonthStart)
    .order("date");

  const hist = {};
  for (const p of providers) {
    hist[p.email] = { total: 0, weekends: 0, fridays: 0, weekdays: 0, lastDate: null };
  }

  let historyCount = 0;
  for (const row of (historyRows || [])) {
    const email = row.providers?.email;
    if (!email || !hist[email]) continue;
    const dow = new Date(row.date + "T00:00:00").getDay();
    hist[email].total++;
    historyCount++;
    if (dow === 5) hist[email].fridays++;
    if (dow === 6 || dow === 0) hist[email].weekends++;
    if (dow >= 1 && dow <= 4) hist[email].weekdays++;
    if (!hist[email].lastDate || row.date > hist[email].lastDate) hist[email].lastDate = row.date;
  }

  console.log(`[generate-schedule] ${monthName} ${year} — DB history rows: ${historyCount}`);
  console.log("[generate-schedule] Weekend counts going in:", 
    providers.map(p => `${p.name.replace("Dr. ","")}: ${hist[p.email].weekends}`).join(", "));

  // ── Normalize new providers to group average ──────────────────────────────
  const providersWithHistory = providers.filter(p => hist[p.email].total > 0);
  if (providersWithHistory.length > 0) {
    const avgTotal    = Math.round(providersWithHistory.reduce((s, p) => s + hist[p.email].total, 0) / providersWithHistory.length);
    const avgWeekends = Math.round(providersWithHistory.reduce((s, p) => s + hist[p.email].weekends, 0) / providersWithHistory.length);
    const avgFridays  = Math.round(providersWithHistory.reduce((s, p) => s + hist[p.email].fridays, 0) / providersWithHistory.length);
    const avgWeekdays = Math.round(providersWithHistory.reduce((s, p) => s + hist[p.email].weekdays, 0) / providersWithHistory.length);

    for (const p of providers) {
      if (hist[p.email].total === 0) {
        hist[p.email].total    = avgTotal;
        hist[p.email].weekends = avgWeekends;
        hist[p.email].fridays  = avgFridays;
        hist[p.email].weekdays = avgWeekdays;
        console.log(`[generate-schedule] Normalized new provider ${p.name} to group average (total: ${avgTotal})`);
      }
    }
  }

  // Build all dates (no Sundays)
  const allDates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month, d).getDay();
    if (dow === 0) continue;
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    allDates.push({ date: dateStr, dow });
  }

  const fridays   = allDates.filter(d => d.dow === 5).map(d => d.date);
  const saturdays = allDates.filter(d => d.dow === 6).map(d => d.date);
  const weekdays  = allDates.filter(d => d.dow >= 1 && d.dow <= 4).map(d => d.date);

  // Build email→provider map for quick lookup of no_call_day
  const providerByEmail = {};
  for (const p of providers) providerByEmail[p.email] = p;

  // Hard block: Days Off OR Off Call Only requests — never assign call
  const isHardBlocked = (email, dateStr) =>
    approvedRequests.some(r =>
      r.email === email &&
      (r.type === "Days Off" || r.type === "Off Call Only") &&
      dateStr >= r.start_date && dateStr <= r.end_date
    );

  // Soft block: recurring no-call day — skip if possible, allow as last resort
  const isSoftBlocked = (email, dateStr) => {
    const p = providerByEmail[email];
    if (!p || p.no_call_day === null || p.no_call_day === undefined) return false;
    const dow = new Date(dateStr + "T00:00:00").getDay();
    return dow === p.no_call_day;
  };

  // isBlocked = hard block only
  const isBlocked = (email, dateStr) => isHardBlocked(email, dateStr);

  const lastAssigned = {};
  for (const p of providers) lastAssigned[p.email] = hist[p.email].lastDate;

  const gapOk = (email, dateStr, minGap = 4) => {
    const last = lastAssigned[email];
    if (!last) return true;
    const diff = Math.floor((new Date(dateStr + "T00:00:00") - new Date(last + "T00:00:00")) / 86400000);
    return diff > minGap;
  };

  // Track how many of each category each provider has been assigned THIS month
  const monthCount = {};
  for (const p of providers) monthCount[p.email] = { weekends: 0, fridays: 0, weekdays: 0 };

  // Pick best provider for a given date/category
  // Priority: 1) never back-to-back, 2) fewest assigned THIS month, 3) longest rest
  // Soft block (recurring no-call day): skipped if anyone else available, last resort only
  const pickBest = (candidates, dateStr, category, excludeEmails = []) => {
    const eligible = candidates.filter(p =>
      !excludeEmails.includes(p.email) && !isHardBlocked(p.email, dateStr)
    );
    if (eligible.length === 0) return null;

    const gap = (email) => {
      const last = lastAssigned[email];
      if (!last) return 999;
      return Math.floor((new Date(dateStr+"T00:00:00") - new Date(last+"T00:00:00")) / 86400000);
    };

    const sortFn = (a, b) => {
      const aGap = gap(a.email); const bGap = gap(b.email);
      if ((aGap <= 1) !== (bGap <= 1)) return aGap <= 1 ? 1 : -1;
      const monthDiff = monthCount[a.email][category] - monthCount[b.email][category];
      if (monthDiff !== 0) return monthDiff;
      return bGap - aGap;
    };

    // Prefer providers NOT on their recurring no-call day
    const preferred = eligible.filter(p => !isSoftBlocked(p.email, dateStr));
    if (preferred.length > 0) return preferred.slice().sort(sortFn)[0];

    // Last resort: assign on recurring no-call day (avoids leaving day blank)
    console.log(`[generate-schedule] WARNING: ${dateStr} assigned to provider on recurring no-call day (no other option)`);
    return eligible.slice().sort(sortFn)[0];
  };

  const schedule = {};

  const assign = (email, dateStr, category) => {
    schedule[dateStr] = email;
    hist[email][category]++;
    hist[email].total++;
    monthCount[email][category]++;
    lastAssigned[email] = dateStr;
  };

  // Process all days in strict chronological order.
  // For each day: Saturday → assign + immediately mirror Sunday (so lastAssigned
  // is correct before the next day is processed). Friday → exclude adjacent Saturday
  // provider if already known (it will be known since Sat comes after Fri in the week,
  // but we look ahead). Weekday Mon → exclude prior Sunday provider.
  //
  // Weekend spreading: track satAssignedThisMonth to ensure one weekend per provider
  // before allowing a second. This must be checked before gap/count sorting.

  const satAssignedThisMonth = {};

  // Build a full ordered list of all days to process (excluding Sundays — handled via mirror)
  const allDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month, d).getDay();
    if (dow === 0) continue; // Sundays handled by Saturday mirror
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    let cat = dow === 6 ? "weekends" : dow === 5 ? "fridays" : "weekdays";
    allDays.push({ dateStr, dow, cat });
  }

  for (const { dateStr, dow, cat } of allDays) {
    if (cat === "weekends") {
      // Saturday: spread one per provider first, then allow repeats
      const noWeekendYet = providers.filter(p => !satAssignedThisMonth[p.email]);
      let pick = pickBest(noWeekendYet, dateStr, "weekends");
      if (!pick) pick = pickBest(providers, dateStr, "weekends");
      if (pick) {
        assign(pick.email, dateStr, "weekends");
        satAssignedThisMonth[pick.email] = (satAssignedThisMonth[pick.email] || 0) + 1;
        // Mirror to Sunday immediately so lastAssigned is correct for Monday
        const sunDate = new Date(new Date(dateStr+"T00:00:00").getTime() + 86400000);
        if (sunDate.getMonth() === month) {
          const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
          schedule[sunStr] = pick.email;
          lastAssigned[pick.email] = sunStr;
          monthCount[pick.email]["weekends"]++;
        }
      }
    } else if (cat === "fridays") {
      // Friday: exclude whoever has the following Saturday (already assigned above
      // since we process chronologically and Sat comes after Fri in same week — 
      // actually Sat is the NEXT day after Fri, so it's processed AFTER this Friday.
      // Look ahead: find if next day (Sat) is already assigned from a prior week's carryover.
      // In practice, the adjacent Saturday hasn't been assigned yet when we hit Friday.
      // So we skip the exclusion here — the Saturday person will be assigned next iteration.
      // To enforce Fri != adjacent Sat: we'll do a post-pass swap if needed.
      const pick = pickBest(providers, dateStr, "fridays");
      if (pick) assign(pick.email, dateStr, "fridays");
    } else {
      // Weekday: exclude whoever worked Sunday before a Monday
      let exclude = [];
      if (dow === 1) {
        const sunDate = new Date(new Date(dateStr+"T00:00:00").getTime() - 86400000);
        const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
        if (schedule[sunStr]) exclude = [schedule[sunStr]];
      }
      const pick = pickBest(providers, dateStr, "weekdays", exclude);
      if (pick) assign(pick.email, dateStr, "weekdays");
    }
  }

  // Post-pass: fix any Friday that shares a provider with the following Saturday
  for (const { dateStr, dow } of allDays) {
    if (dow !== 5) continue; // only Fridays
    const satDate = new Date(new Date(dateStr+"T00:00:00").getTime() + 86400000);
    const satStr = `${satDate.getFullYear()}-${String(satDate.getMonth()+1).padStart(2,"0")}-${String(satDate.getDate()).padStart(2,"0")}`;
    if (schedule[dateStr] && schedule[satStr] && schedule[dateStr] === schedule[satStr]) {
      // Conflict: reassign the Friday to someone else
      const pick = pickBest(providers, dateStr, "fridays", [schedule[satStr]]);
      if (pick) {
        // Undo the old friday assignment from monthCount/hist
        const oldEmail = schedule[dateStr];
        hist[oldEmail]["fridays"]--;
        hist[oldEmail]["total"]--;
        monthCount[oldEmail]["fridays"]--;
        assign(pick.email, dateStr, "fridays");
      }
    }
  }

  // 4. Mirror Saturday → Sunday (handles same-month AND cross-month boundary)
  //    If month starts on Sunday, mirror from last Saturday of prior month
  const firstDayDow = new Date(year, month, 1).getDay();
  if (firstDayDow === 0) {
    // First day of this month is Sunday — find who had last Saturday of prior month
    const prevMonthLastDay = new Date(year, month, 0); // last day of prior month
    const prevSatStr = `${prevMonthLastDay.getFullYear()}-${String(prevMonthLastDay.getMonth()+1).padStart(2,"0")}-${String(prevMonthLastDay.getDate()).padStart(2,"0")}`;
    const sunStr = `${year}-${String(month+1).padStart(2,"0")}-01`;
    // Look up prior month's last Saturday from DB
    const { data: prevSatRow } = await supabase
      .from("call_schedule")
      .select("providers(email)")
      .eq("date", prevSatStr)
      .single();
    const prevSatEmail = prevSatRow?.providers?.email;
    if (prevSatEmail && !isBlocked(prevSatEmail, sunStr)) {
      schedule[sunStr] = prevSatEmail;
      console.log(`[generate-schedule] Cross-month mirror: ${sunStr} (Sun) → ${prevSatEmail} from ${prevSatStr} (Sat)`);
    }
  }

  // Same-month Sat→Sun mirroring is handled inline in step 1 above.
  // (Kept here as safety net for any edge cases)
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month, d).getDay() === 6) {
      const satStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const sunDate = new Date(year, month, d + 1);
      if (sunDate.getMonth() === month) {
        const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
        if (schedule[satStr] && !schedule[sunStr]) schedule[sunStr] = schedule[satStr];
      }
    }
  }

  const counts = providers.map(p => {
    const n = Object.values(schedule).filter(e => e === p.email).length;
    return `${p.name.replace("Dr. ", "")}: ${n}`;
  }).join(", ");

  console.log(`[generate-schedule] ${monthName} ${year} final counts: ${counts}`);

  return res.status(200).json({
    schedule,
    summary: `${monthName} ${year}: ${counts}. Fair rotation from live DB history.`
  });
}
