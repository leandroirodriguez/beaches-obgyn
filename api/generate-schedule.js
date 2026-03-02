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
    `- ${p.name} (${p.credentials}, no-call day preference: ${p.no_call_day || "none"}, participation: ${p.participation_percent || 100}%)`
  ).join("\n");

  const requestList = requests.length > 0
    ? requests.filter(r => r.status === "Approved").map(r =>
        `- ${r.providers?.name}: ${r.type} from ${r.start_date} to ${r.end_date}`
      ).join("\n")
    : "No approved time-off requests.";

  const previousCalls = previousSchedule
    ? Object.entries(previousSchedule).map(([date, p]) => `${date}: ${p.name}`).join("\n")
    : "No previous schedule data available.";

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
2. Maximum 1 call shift per provider every 3 days minimum
3. Minimum 3 weeks between weekend call shifts for the same provider
4. Respect all approved time-off requests
5. Distribute weekday calls and weekend calls fairly across all providers
6. MAXIMIZE the gap between each provider's call shifts
7. Balance the total number of calls per provider as evenly as possible
8. Respect no-call day preferences where possible
9. Do not assign a provider who had the last call of the previous month to the first day of this month

Respond ONLY with a valid JSON object in this exact format, no explanation, no markdown:
{
  "schedule": {
    "YYYY-MM-DD": "provider_email",
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