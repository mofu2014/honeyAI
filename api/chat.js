export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", chunk => data += chunk);
      req.on("end", () => resolve(JSON.parse(data)));
      req.on("error", reject);
    });

    const { message } = body;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [
          { role: "system", content: "あなたは優秀なAIアシスタントです。" },
          { role: "user", content: message }
        ]
      })
    });

    const data = await response.json();

    return res.status(200).json({
      reply: data.choices?.[0]?.message?.content || "エラー"
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
