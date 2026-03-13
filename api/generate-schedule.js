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
  const monthStart = `${year}-${String(month+1).padStart(2,"0")}-01`;
  const monthEnd   = `${year}-${String(month+1).padStart(2,"0")}-${String(daysInMonth).padStart(2,"0")}`;
 
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
 
  // Soft block: recurring no-call days — tiered by priority rank
  // Returns: 0 = not blocked, 1 = secondary (skip if anyone else avail), 2 = primary (skip unless only option)
  const noCallBlockLevel = (email, dateStr) => {
    const p = providerByEmail[email];
    const dow = new Date(dateStr + "T00:00:00").getDay();
    // Use no_call_days array if available, fall back to no_call_day
    const days = p?.no_call_days?.length ? p.no_call_days : (p?.no_call_day != null ? [p.no_call_day] : []);
    const idx = days.indexOf(dow);
    if (idx === -1) return 0;       // not a no-call day
    if (idx === 0) return 2;        // top priority — hardest to override
    return 1;                       // secondary — skip if anyone else available
  };
  const isSoftBlocked = (email, dateStr) => noCallBlockLevel(email, dateStr) > 0;
 
  const lastAssigned = {};
  for (const p of providers) lastAssigned[p.email] = hist[p.email].lastDate;
 
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
 
    // Tiered soft-block: prefer providers not on any no-call day
    const notSoftBlocked = eligible.filter(p => noCallBlockLevel(p.email, dateStr) === 0);
    if (notSoftBlocked.length > 0) return notSoftBlocked.slice().sort(sortFn)[0];
 
    // Next: allow secondary no-call days (lower priority) if no one else available
    const notPrimaryBlocked = eligible.filter(p => noCallBlockLevel(p.email, dateStr) < 2);
    if (notPrimaryBlocked.length > 0) {
      console.log(`[generate-schedule] NOTE: ${dateStr} assigned to provider on secondary no-call day`);
      return notPrimaryBlocked.slice().sort(sortFn)[0];
    }
 
    // Last resort: assign on top-priority no-call day (only if truly no other option)
    console.log(`[generate-schedule] WARNING: ${dateStr} assigned to provider on PRIMARY no-call day (no other option)`);
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
 
  // ── Preferred On-Call Pre-Pass ────────────────────────────────────────────
  // Fetch all pending preferred requests for this month, sorted fewest-calls first
  const { data: prefRows } = await supabase
    .from("preferred_call_requests")
    .select("id, provider_id, call_date, notes")
    .eq("status", "pending")
    .gte("call_date", monthStart)
    .lte("call_date", monthEnd)
    .order("call_date", { ascending: true });
 
  // Build a vacation set for fast lookup: "providerId_dateStr"
  const vacationSet = new Set();
  for (const r of approvedRequests) {
    if (r.type === "Days Off" || r.type === "Off Call Only") {
      const start = new Date(r.start_date + "T00:00:00");
      const end   = new Date(r.end_date   + "T00:00:00");
      for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
        const ds = d.toISOString().split("T")[0];
        vacationSet.add(`${r.provider_id}_${ds}`);
      }
    }
  }
 
  // Annotate each pref with current call count, sort fewest-calls first
  const prefs = (prefRows || []).map(r => ({
    ...r,
    currentCalls: hist[providerEmailMap[r.provider_id]]?.total || 0,
  })).sort((a, b) =>
    a.currentCalls !== b.currentCalls
      ? a.currentCalls - b.currentCalls
      : new Date(a.call_date) - new Date(b.call_date)
  );
 
  const preferredAssignment = {}; // dateStr → providerEmail (pre-assigned by preference)
  const honoredPrefIds  = [];
  const skippedPrefIds  = {};    // id → reason
 
  const decidedPrefIds = new Set();
 
  for (const pref of prefs) {
    if (decidedPrefIds.has(pref.id)) continue;
 
    const email = providerEmailMap[pref.provider_id];
    if (!email) { decidedPrefIds.add(pref.id); continue; }
 
    const callDate = pref.call_date;
    const d = new Date(callDate + "T12:00:00");
    const dow = d.getDay();
 
    // Build list of dates this pref covers (1 day, or Sat+Sun pair)
    const datesToAssign = [callDate];
    if (dow === 6) {
      const sun = new Date(d); sun.setDate(sun.getDate()+1);
      const sunStr = sun.toISOString().split("T")[0];
      if (sunStr <= monthEnd) datesToAssign.push(sunStr);
    } else if (dow === 0) {
      const sat = new Date(d); sat.setDate(sat.getDate()-1);
      const satStr = sat.toISOString().split("T")[0];
      if (satStr >= monthStart) datesToAssign.push(satStr);
    }
 
    // Find paired pref row (auto-inserted weekend pair)
    const pairedPref = dow === 6 || dow === 0
      ? prefs.find(p =>
          p.provider_id === pref.provider_id &&
          p.id !== pref.id &&
          datesToAssign.includes(p.call_date) &&
          !decidedPrefIds.has(p.id)
        )
      : null;
 
    // Check: already taken by another preference winner?
    const alreadyTaken = datesToAssign.some(dt => preferredAssignment[dt]);
    if (alreadyTaken) {
      skippedPrefIds[pref.id] = "Another provider with fewer total calls was assigned this date";
      decidedPrefIds.add(pref.id);
      if (pairedPref) { skippedPrefIds[pairedPref.id] = "Weekend pair skipped"; decidedPrefIds.add(pairedPref.id); }
      continue;
    }
 
    // Check: provider on vacation that day?
    const onVacation = datesToAssign.some(dt => vacationSet.has(`${pref.provider_id}_${dt}`));
    if (onVacation) {
      skippedPrefIds[pref.id] = "Provider has approved time off on this date";
      decidedPrefIds.add(pref.id);
      if (pairedPref) { skippedPrefIds[pairedPref.id] = "Weekend pair skipped"; decidedPrefIds.add(pairedPref.id); }
      continue;
    }
 
    // Check: fairness gate — provider significantly above average?
    const teamAvg = providers.reduce((s, p) => s + (hist[p.email]?.total || 0), 0) / providers.length;
    if (pref.currentCalls > teamAvg + 1.5) {
      skippedPrefIds[pref.id] = `Already has ${pref.currentCalls} calls vs team avg ${teamAvg.toFixed(1)}`;
      decidedPrefIds.add(pref.id);
      if (pairedPref) { skippedPrefIds[pairedPref.id] = "Weekend pair skipped — fairness gate"; decidedPrefIds.add(pairedPref.id); }
      continue;
    }
 
    // All checks passed — honor it
    for (const dt of datesToAssign) {
      preferredAssignment[dt] = email;
      // Update hist so fairness gate is accurate for subsequent prefs
      const cat = new Date(dt + "T00:00:00").getDay();
      const catKey = cat === 6 || cat === 0 ? "weekends" : cat === 5 ? "fridays" : "weekdays";
      hist[email][catKey]++;
      hist[email].total++;
    }
    honoredPrefIds.push(pref.id);
    decidedPrefIds.add(pref.id);
    if (pairedPref) { honoredPrefIds.push(pairedPref.id); decidedPrefIds.add(pairedPref.id); }
    console.log(`[generate-schedule] ⭐ Honored preferred call: ${email} on ${datesToAssign.join(", ")}`);
  }
 
  // Update preference statuses in DB (fire and forget — don't block schedule generation)
  if (honoredPrefIds.length > 0) {
    supabase.from("preferred_call_requests").update({ status:"honored" }).in("id", honoredPrefIds).then();
  }
  for (const [id, reason] of Object.entries(skippedPrefIds)) {
    supabase.from("preferred_call_requests").update({ status:"skipped", skip_reason:reason }).eq("id", id).then();
  }
 
  // ── Main scheduling loop ──────────────────────────────────────────────────
 
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
    // If this date was pre-assigned by a preferred call request, use it directly
    if (preferredAssignment[dateStr]) {
      const email = preferredAssignment[dateStr];
      schedule[dateStr] = email;
      // Mirror Sunday for preferred Saturday
      if (dow === 6) {
        const sunDate = new Date(new Date(dateStr+"T00:00:00").getTime() + 86400000);
        if (sunDate.getMonth() === month) {
          const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
          schedule[sunStr] = email;
          lastAssigned[email] = sunStr;
          if (!satAssignedThisMonth[email]) satAssignedThisMonth[email] = 0;
          satAssignedThisMonth[email]++;
        }
      }
      lastAssigned[email] = dateStr;
      continue;
    }
 
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
    if (prevSatEmail && !isHardBlocked(prevSatEmail, sunStr)) {
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