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

  const pickBest = (candidates, dateStr, category, excludeEmails = []) => {
    // Try with full gap (4 days)
    let eligible = candidates.filter(p =>
      !excludeEmails.includes(p.email) &&
      !isBlocked(p.email, dateStr) &&
      gapOk(p.email, dateStr, 4)
    );
    // Relax to 2-day gap
    if (eligible.length === 0) {
      eligible = candidates.filter(p =>
        !excludeEmails.includes(p.email) &&
        !isBlocked(p.email, dateStr) &&
        gapOk(p.email, dateStr, 2)
      );
    }
    // Relax to 1-day gap (no back-to-back)
    if (eligible.length === 0) {
      eligible = candidates.filter(p =>
        !excludeEmails.includes(p.email) &&
        !isBlocked(p.email, dateStr) &&
        gapOk(p.email, dateStr, 1)
      );
    }
    // Last resort: anyone not blocked (may result in consecutive days but avoids blank)
    if (eligible.length === 0) {
      eligible = candidates.filter(p => !isBlocked(p.email, dateStr));
    }
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => {
      const gapA = lastAssigned[a.email] ? (new Date(dateStr+"T00:00:00") - new Date(lastAssigned[a.email]+"T00:00:00")) / 86400000 : 999;
      const gapB = lastAssigned[b.email] ? (new Date(dateStr+"T00:00:00") - new Date(lastAssigned[b.email]+"T00:00:00")) / 86400000 : 999;
      // If category counts differ by more than 1, prioritize fairness
      const catDiff = hist[a.email][category] - hist[b.email][category];
      if (Math.abs(catDiff) > 1) return catDiff;
      // If total counts differ by more than 2, prioritize fairness
      const totDiff = hist[a.email].total - hist[b.email].total;
      if (Math.abs(totDiff) > 2) return totDiff;
      // Otherwise prioritize whoever has rested longest (avoids consecutive days)
      return gapB - gapA;
    });
    return eligible[0];
  };

  const schedule = {};

  const assign = (email, dateStr, category) => {
    schedule[dateStr] = email;
    hist[email][category]++;
    hist[email].total++;
    lastAssigned[email] = dateStr;
  };

  // 1. Saturdays — fewest weekends first, NO cap on how many per provider per month
  //    (cap caused blank days in months with many blocked providers)
  for (const satDate of saturdays) {
    const pick = pickBest(providers, satDate, "weekends");
    if (pick) assign(pick.email, satDate, "weekends");
  }

  // 2. Fridays — must differ from adjacent Saturday
  for (const friDate of fridays) {
    const friD = parseInt(friDate.split("-")[2]);
    const satDate = saturdays.find(s => parseInt(s.split("-")[2]) === friD + 1);
    const satEmail = satDate ? schedule[satDate] : null;
    const pick = pickBest(providers, friDate, "fridays", satEmail ? [satEmail] : []);
    if (pick) assign(pick.email, friDate, "fridays");
  }

  // 3. Weekdays
  for (const wdDate of weekdays) {
    const pick = pickBest(providers, wdDate, "weekdays");
    if (pick) assign(pick.email, wdDate, "weekdays");
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

  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month, d).getDay() === 6) {
      const satStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const sunDate = new Date(year, month, d + 1);
      // Only mirror if Sunday is still within the same month
      if (sunDate.getMonth() === month) {
        const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
        if (schedule[satStr]) schedule[sunStr] = schedule[satStr];
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
