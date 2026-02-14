export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "GROQ_API_KEY missing" });
    }

    const { message, personality } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message missing" });
    }

    const systemPrompt = `
あなたはHoneyAIです。
性格: ${personality || "敬語"}
自然で一貫した人格を維持してください。
`;

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama3-70b-8192",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message }
          ],
          temperature: 0.8
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.log("Groq error:", data);
      return res.status(500).json({ error: data });
    }

    const reply = data.choices?.[0]?.message?.content || "...";

    res.status(200).json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
