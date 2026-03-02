import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.VITE_ANTHROPIC_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { providers, requests, year, month, previousSchedule } = req.body;

  const monthName = new Date(year, month, 1).toLocaleString("default", { month: "long" });
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const providerList = providers.map(p =>
    `- ${p.name} (${p.credentials}, email: ${p.email}, no-call day preference: ${p.no_call_day || "none"}, participation: ${p.participation_percent || 100}%)`
  ).join("\n");

  const requestList = requests.length > 0
    ? requests.filter(r => r.status === "Approved").map(r =>
        `- ${r.providers?.name}: ${r.type} from ${r.start_date} to ${r.end_date}`
      ).join("\n")
    : "No approved time-off requests.";

  const previousCalls = previousSchedule
    ? Object.entries(previousSchedule).map(([date, p]) => `${date}: ${p.name}`).join("\n")
    : "No previous schedule data available.";

  const emailList = providers.map(p => p.email).join(", ");

  // Build list of Fridays, Saturdays, Sundays in the month
  const weekendInfo = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dow = date.getDay();
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    if (dow === 5) weekendInfo.push(`${dateStr} is a FRIDAY — assign one provider`);
    if (dow === 6) weekendInfo.push(`${dateStr} is a SATURDAY — assign one provider who will also cover Sunday automatically`);
    if (dow === 0) weekendInfo.push(`${dateStr} is a SUNDAY — assign the SAME provider as the Saturday before it`);
  }

  const prompt = `You are scheduling on-call assignments for an OBGYN practice called Beaches OBGYN for ${monthName} ${year}.

The month has ${daysInMonth} days.

PROVIDERS:
${providerList}

APPROVED TIME-OFF REQUESTS (these dates must be excluded for those providers):
${requestList}

PREVIOUS MONTH CALL HISTORY (use this to ensure fairness continuity):
${previousCalls}

WEEKEND STRUCTURE (very important):
${weekendInfo.join("\n")}

CALL RULES:
1. Each day needs exactly one provider on call (7AM to 7AM next day)
2. Weekdays (Mon-Thu): assign one provider per day
3. FRIDAY: assign one provider — this counts as one weekend shift for that provider
4. SATURDAY: assign one provider — this provider automatically covers Sunday too
5. SUNDAY: assign the EXACT SAME provider as Saturday
6. Friday and Saturday must ALWAYS be different providers
7. Minimum 3 days between any two call shifts for the same provider
8. Minimum 3 weeks between weekend shifts (Fri OR Sat/Sun) for the same provider
9. Respect all approved time-off requests
10. MAXIMIZE the gap between each provider's call shifts
11. Balance total calls fairly — count Saturday+Sunday as 2 calls for that provider, Friday as 1 call
12. Respect no-call day preferences where possible

CRITICAL: Use ONLY these exact email addresses: ${emailList}
Do NOT invent or modify any emails.

Respond ONLY with a valid JSON object, no explanation, no markdown:
{
  "schedule": {
    "YYYY-MM-DD": "provider_email"
  },
  "summary": "A brief 2-sentence summary of how fairness was achieved"
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

    return res.status(200).json(result);
  } catch (err) {
    console.error("AI schedule error:", err);
    return res.status(500).json({ error: err.message });
  }
}
