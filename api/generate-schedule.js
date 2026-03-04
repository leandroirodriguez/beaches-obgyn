import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.VITE_ANTHROPIC_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { providers, requests, year, month, previousSchedule } = req.body;

  const monthName = new Date(year, month, 1).toLocaleString("default", { month: "long" });
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const providerEmailMap = {};
  for (const p of providers) providerEmailMap[p.id] = p.email;

  const approvedRequests = requests.filter(r => r.status === "Approved").map(r => ({
    ...r,
    email: r.providers?.email || providerEmailMap[r.provider_id] || null,
    name: r.providers?.name || providers.find(p => p.id === r.provider_id)?.name || "Unknown",
  })).filter(r => r.email);

  const requestList = approvedRequests.length > 0
    ? approvedRequests.map(r => {
        const endDate = new Date(r.end_date);
        const nextDay = new Date(endDate);
        nextDay.setDate(endDate.getDate() + 1);
        const nextDayStr = `${nextDay.getFullYear()}-${String(nextDay.getMonth()+1).padStart(2,"0")}-${String(nextDay.getDate()).padStart(2,"0")}`;
        return `- ${r.name} (${r.email}): ${r.type} from ${r.start_date} to ${r.end_date} — BLOCKED through ${r.end_date}. First available: ${nextDayStr}.`;
      }).join("\n")
    : "No approved time-off requests.";

  // Build list of all date types
  const fridays = [], saturdays = [], weekdays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dow = date.getDay();
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    if (dow === 5) fridays.push(dateStr);
    else if (dow === 6) saturdays.push(dateStr);
    else if (dow !== 0) weekdays.push(dateStr); // Mon-Thu
  }

  // Count previous call history per provider from previousSchedule
  const prevCounts = {};
  const prevWeekendCounts = {};
  const prevFridayCounts = {};
  const prevWeekdayCounts = {};
  const lastCallDate = {};

  for (const p of providers) {
    prevCounts[p.email] = 0;
    prevWeekendCounts[p.email] = 0;
    prevFridayCounts[p.email] = 0;
    prevWeekdayCounts[p.email] = 0;
    lastCallDate[p.email] = null;
  }

  if (previousSchedule) {
    const sortedDates = Object.keys(previousSchedule).sort();
    for (const date of sortedDates) {
      const prov = previousSchedule[date];
      if (!prov?.email) continue;
      const email = prov.email;
      if (!prevCounts[email] && prevCounts[email] !== 0) continue;
      const dow = new Date(date + "T00:00:00").getDay();
      prevCounts[email] = (prevCounts[email] || 0) + 1;
      if (dow === 6 || dow === 0) prevWeekendCounts[email] = (prevWeekendCounts[email] || 0) + 1;
      if (dow === 5) prevFridayCounts[email] = (prevFridayCounts[email] || 0) + 1;
      if (dow >= 1 && dow <= 4) prevWeekdayCounts[email] = (prevWeekdayCounts[email] || 0) + 1;
      lastCallDate[email] = date;
    }
  }

  // Build fairness summary for AI
  const fairnessSummary = providers.map(p => {
    const daysSinceLastCall = lastCallDate[p.email]
      ? Math.floor((new Date(`${year}-${String(month+1).padStart(2,"0")}-01`) - new Date(lastCallDate[p.email] + "T00:00:00")) / 86400000)
      : 999;
    return `- ${p.name} (${p.email}): ${prevCounts[p.email]} total calls, ${prevWeekendCounts[p.email]} Sat/Sun, ${prevFridayCounts[p.email]} Fridays, ${prevWeekdayCounts[p.email]} weekdays. Last call: ${lastCallDate[p.email] || "none"} (${daysSinceLastCall} days ago)`;
  }).join("\n");

  // Calculate target distributions for this month
  const totalDaysThisMonth = fridays.length + saturdays.length + weekdays.length;
  const targetTotal = Math.floor(totalDaysThisMonth / providers.length);
  const targetSat = Math.floor(saturdays.length / providers.length);
  const targetFri = Math.floor(fridays.length / providers.length);

  // Identify who needs weekend call most (lowest count gets priority)
  const sortedByWeekend = [...providers].sort((a, b) =>
    (prevWeekendCounts[a.email] || 0) - (prevWeekendCounts[b.email] || 0)
  );
  const weekendPriority = sortedByWeekend.map(p =>
    `${p.name}: ${prevWeekendCounts[p.email]} weekends so far — ${prevWeekendCounts[p.email] <= (sortedByWeekend[0] ? prevWeekendCounts[sortedByWeekend[0].email] : 0) + 1 ? "NEEDS weekend call" : "has enough weekends"}`
  ).join("\n");

  const emailList = providers.map(p => p.email).join(", ");
  const providerCount = providers.length;

  const providerList = providers.map(p =>
    `- ${p.name} (${p.credentials}, email: ${p.email}, no-call day: ${p.no_call_day || "none"})`
  ).join("\n");

  const prompt = `You are scheduling on-call assignments for Beaches OBGYN for ${monthName} ${year}.

${daysInMonth} days, ${providerCount} providers.

PROVIDERS:
${providerList}

APPROVED TIME-OFF (provider is COMPLETELY BLOCKED on these dates):
${requestList}

CUMULATIVE CALL HISTORY (from all previous months — use this to balance fairly):
${fairnessSummary}

WEEKEND PRIORITY FOR THIS MONTH (assign weekends to providers with FEWEST weekend calls first):
${weekendPriority}

THIS MONTH'S DATES:
- Weekdays (Mon-Thu): ${weekdays.join(", ")}
- Fridays: ${fridays.join(", ")}
- Saturdays: ${saturdays.join(", ")}
(Do NOT include Sundays — they are automatically copied from Saturday in code)

TARGETS FOR THIS MONTH:
- Each provider should get approximately ${targetTotal} calls
- Each provider should get at most ${targetSat + 1} Saturday(s)
- Each provider should get at most ${targetFri + 1} Friday(s)
- Providers with MORE weekend history should get FEWER weekends this month
- Providers with FEWER weekend history should get MORE weekends this month

STRICT RULES (ALL must be followed):
1. Every day needs exactly one provider
2. MINIMUM 3 DAYS between any two calls for the same provider — NEVER assign same provider on consecutive days or with only 1-2 days gap
3. MAXIMIZE spacing between calls for each provider — spread them as evenly as possible through the month
4. Friday and Saturday MUST be different providers ALWAYS
5. No provider gets more than 1 Saturday
6. No provider gets more than 2 Fridays
7. No provider on time-off is assigned ANY call during their blocked dates
8. Provider who had last call of previous month does NOT get first call of this month
9. After a provider has a weekend call (Fri or Sat), give them at least 3 weeks before next weekend call
10. Balance total calls: no provider should have more than 2 calls difference from any other provider

CRITICAL FAIRNESS: The provider with the MOST weekend calls historically must get the FEWEST this month. The provider with the FEWEST weekend calls historically must get the MOST this month.

ONLY use these exact email addresses: ${emailList}
Do NOT include Sundays.

Respond ONLY with valid JSON, no explanation, no markdown:
{
  "schedule": {
    "YYYY-MM-DD": "provider_email"
  },
  "summary": "2-sentence summary of fairness achieved"
}`;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    const schedule = { ...result.schedule };

    // ── Enforce Sat → Sun copy ──────────────────────────────────────────────
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      if (date.getDay() === 6) {
        const satStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
        const sunDate = new Date(year, month, d + 1);
        const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
        if (schedule[satStr]) schedule[sunStr] = schedule[satStr];
      }
    }

    // ── Enforce max 1 Saturday per provider ────────────────────────────────
    const satCounts = {};
    for (const satDate of saturdays) {
      const email = schedule[satDate];
      if (!email) continue;
      if (satCounts[email]) {
        const available = providers.map(p => p.email).find(e => !satCounts[e]);
        if (available) {
          schedule[satDate] = available;
          const satD = parseInt(satDate.split("-")[2]);
          const sunDate = new Date(year, month, satD + 1);
          const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
          schedule[sunStr] = available;
          satCounts[available] = 1;
        }
      } else {
        satCounts[email] = 1;
      }
    }

    // ── Enforce minimum 3-day gap between calls ─────────────────────────────
    const sortedDates = Object.keys(schedule).sort();
    for (let i = 1; i < sortedDates.length; i++) {
      const dateA = sortedDates[i - 1];
      const dateB = sortedDates[i];
      if (schedule[dateA] === schedule[dateB]) {
        const gap = (new Date(dateB + "T00:00:00") - new Date(dateA + "T00:00:00")) / 86400000;
        if (gap < 3) {
          // Find a replacement with largest gap
          const used = new Set(
            sortedDates
              .filter(d => {
                const diff = Math.abs((new Date(dateB + "T00:00:00") - new Date(d + "T00:00:00")) / 86400000);
                return diff < 3;
              })
              .map(d => schedule[d])
          );
          const replacement = providers
            .map(p => p.email)
            .find(e => !used.has(e) && !approvedRequests.some(r => {
              if (r.email !== e) return false;
              const s = new Date(r.start_date + "T00:00:00");
              const en = new Date(r.end_date + "T00:00:00");
              const cur = new Date(dateB + "T00:00:00");
              return cur >= s && cur <= en;
            }));
          if (replacement) schedule[dateB] = replacement;
        }
      }
    }

    // ── Enforce time-off blocks ─────────────────────────────────────────────
    for (const r of approvedRequests) {
      const start = new Date(r.start_date + "T00:00:00");
      const end = new Date(r.end_date + "T00:00:00");
      for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
        const dateStr = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
        if (schedule[dateStr] === r.email) {
          const replacement = providers.find(p => {
            if (p.email === r.email) return false;
            return !approvedRequests.some(req => {
              if (req.email !== p.email) return false;
              const s = new Date(req.start_date + "T00:00:00");
              const e = new Date(req.end_date + "T00:00:00");
              return dt >= s && dt <= e;
            });
          });
          if (replacement) schedule[dateStr] = replacement.email;
        }
      }
    }

    return res.status(200).json({ schedule, summary: result.summary });
  } catch (err) {
    console.error("AI schedule error:", err);
    return res.status(500).json({ error: err.message });
  }
}