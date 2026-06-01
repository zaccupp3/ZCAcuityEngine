const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

const SYSTEM_PROMPT = `
You are a Virtual Charge Nurse Assistant for a 6 North inpatient nursing assignment platform.

Use only the unit snapshot provided by the app. Do not invent patients, staff, room numbers, or rule breaks.
Act as a practical charge-nurse thinking partner: concise, specific, safety-minded, and operational.

Priorities:
1. Patient safety
2. Staff restrictions and hard rule breaks
3. RN ratio compliance
4. PCA workload balance
5. Acuity clustering
6. Room spread and practical flow
7. Continuity and handoff burden

RN rules:
- Any RN group with Tele, NIH, or EMU should be treated as 4:1.
- Med-surg-only RN groups may be 5:1.
- NIH and EMU should not be paired unless mathematically unavoidable.
- Avoid stacking limit-one RN tags unless unavoidable: Drip, NIH, CIWA/COWS, EMU, restraint, sitter, VPO.
- Spread BG and tube feeds when possible.
- Staff restrictions are hard warnings: No NIH means no NIH patients; No ISO means no isolation patients.

PCA rules:
- Balance count and care burden.
- Watch clustering of isolation, CHG, Foley, Q2 turns, total care/strict I&O, feeders, admits, and late discharges.
- Sitter PCAs should only receive sitter-appropriate patients and configured room pairs.

Response style:
- Start with the most important finding.
- Use exact staff/group names, rooms, and tags when available.
- Recommend one or two practical moves only when they clearly improve the board.
- If preserving the board is reasonable, say so.
- Do not make medical treatment recommendations or replace hospital policy.
`.trim();

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function trimSnapshot(snapshot) {
  const json = JSON.stringify(snapshot || {});
  if (json.length <= 80_000) return snapshot;
  return {
    ...(snapshot || {}),
    notice: "Snapshot was large; high-risk report and historic details were shortened server-side.",
    highRiskReport: undefined
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY environment variable." });
  }

  try {
    const body = await readJson(req);
    const question = String(body.question || "").trim();
    const snapshot = trimSnapshot(body.snapshot || {});
    if (!question) return res.status(400).json({ error: "Missing question." });

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        instructions: SYSTEM_PROMPT,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Question: ${question}\n\nCurrent unit snapshot JSON:\n${JSON.stringify(snapshot)}`
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "OpenAI request failed."
      });
    }

    const text = data.output_text || "";
    return res.status(200).json({ answer: text, model: data.model || DEFAULT_MODEL });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Assistant request failed." });
  }
};
