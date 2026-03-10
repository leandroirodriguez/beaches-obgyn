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

  const isBlocked = (email, dateStr) =>
    approvedRequests.some(r => r.email === email && dateStr >= r.start_date && dateStr <= r.end_date);

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
  // Priority: 1) never back-to-back, 2) fewest assigned THIS month, 3) fewest all-time, 4) longest rest
  const pickBest = (candidates, dateStr, category, excludeEmails = []) => {
    const notBlocked = candidates.filter(p =>
      !excludeEmails.includes(p.email) && !isBlocked(p.email, dateStr)
    );
    if (notBlocked.length === 0) return null;

    const gap = (email) => {
      const last = lastAssigned[email];
      if (!last) return 999;
      return Math.floor((new Date(dateStr+"T00:00:00") - new Date(last+"T00:00:00")) / 86400000);
    };

    const sorted = notBlocked.slice().sort((a, b) => {
      const aGap = gap(a.email);
      const bGap = gap(b.email);
      const aBackToBack = aGap <= 1;
      const bBackToBack = bGap <= 1;
      // Never pick back-to-back if anyone else is available
      if (aBackToBack !== bBackToBack) return aBackToBack ? 1 : -1;
      // Fewest assigned this category THIS month (strongest signal — prevents hoarding)
      const monthDiff = monthCount[a.email][category] - monthCount[b.email][category];
      if (monthDiff !== 0) return monthDiff;
      // Longest rest as tiebreaker (gap fairness within month)
      return bGap - aGap;
      // Note: all-time history is intentionally NOT used here — the generator is called
      // with up-to-date history already baked into hist[], so month-level balance is
      // the right signal. Year-round fairness comes from history fed back each month.
    });

    return sorted[0];
  };

  const schedule = {};

  const assign = (email, dateStr, category) => {
    schedule[dateStr] = email;
    hist[email][category]++;
    hist[email].total++;
    monthCount[email][category]++;
    lastAssigned[email] = dateStr;
  };

  // 1. Weekdays first — assign before weekends so weekend assignments don't
  //    poison gap scores for weekday picks (prevents providers with late-month
  //    weekends from being shut out of early-month weekdays).
  //    Monday exclusion of prior Sunday handled via schedule lookup.
  for (const wdDate of weekdays) {
    const d = new Date(wdDate + "T00:00:00");
    const dow = d.getDay();
    let excludeFromWeekend = [];
    if (dow === 1) {
      // Monday — exclude whoever worked Sunday (prior week's Saturday person)
      const sunDate = new Date(d); sunDate.setDate(sunDate.getDate() - 1);
      const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
      if (schedule[sunStr]) excludeFromWeekend = [schedule[sunStr]];
    }
    const pick = pickBest(providers, wdDate, "weekdays", excludeFromWeekend);
    if (pick) assign(pick.email, wdDate, "weekdays");
  }

  // 2. Saturdays + immediately mirror to Sunday
  const satAssignedThisMonth = {};
  for (const satDate of saturdays) {
    const noWeekendYet = providers.filter(p => !satAssignedThisMonth[p.email]);
    let pick = pickBest(noWeekendYet, satDate, "weekends");
    if (!pick) pick = pickBest(providers, satDate, "weekends");
    if (pick) {
      assign(pick.email, satDate, "weekends");
      satAssignedThisMonth[pick.email] = (satAssignedThisMonth[pick.email] || 0) + 1;
      const sunDate = new Date(new Date(satDate+"T00:00:00").getTime() + 86400000);
      if (sunDate.getMonth() === month) {
        const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
        schedule[sunStr] = pick.email;
        lastAssigned[pick.email] = sunStr;
        monthCount[pick.email]["weekends"]++;
      }
    }
  }

  // 3. Fridays — must differ from adjacent Saturday (now already assigned above)
  for (const friDate of fridays) {
    const friD = parseInt(friDate.split("-")[2]);
    const satDate = saturdays.find(s => parseInt(s.split("-")[2]) === friD + 1);
    const satEmail = satDate ? schedule[satDate] : null;
    const pick = pickBest(providers, friDate, "fridays", satEmail ? [satEmail] : []);
    if (pick) assign(pick.email, friDate, "fridays");
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
