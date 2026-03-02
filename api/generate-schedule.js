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

  const prompt = `You are scheduling on-call assignments for an OBGYN practice called Beaches OBGYN for ${monthName} ${year}.

The month has ${daysInMonth} days.

PROVIDERS:
${providerList}

APPROVED TIME-OFF REQUESTS (these dates must be excluded for those providers):
${requestList}

PREVIOUS MONTH CALL HISTORY (use this to ensure fairness continuity):
${previousCalls}

CALL RULES:
1. Each day needs exactly one provider on call (7AM to 7AM next day)
2. Minimum 3 days between any two call shifts for the same provider
3. FRIDAY and SATURDAY must always be different providers
4. Minimum 3 weeks between weekend shifts for the same provider
5. Respect all approved time-off requests
6. MAXIMIZE the gap between each provider's call shifts
7. Balance total calls fairly across all providers
8. Respect no-call day preferences where possible
9. Do not assign a provider who had the last call of the previous month to the first day of this month

NOTE: You only need to assign Saturday — Sunday will automatically be copied from Saturday in post-processing. Do NOT include Sundays in your schedule output.

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

    // ─── Enforce Saturday = Sunday rule in code ───────────────────────────────
    const schedule = { ...result.schedule };
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      if (date.getDay() === 6) { // Saturday
        const satStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
        const sunDate = new Date(year, month, d + 1);
        const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,"0")}-${String(sunDate.getDate()).padStart(2,"0")}`;
        if (schedule[satStr]) {
          schedule[sunStr] = schedule[satStr];
        }
      }
    }

    return res.status(200).json({ schedule, summary: result.summary });
  } catch (err) {
    console.error("AI schedule error:", err);
    return res.status(500).json({ error: err.message });
  }
}