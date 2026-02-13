export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { message } = req.body;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
body: JSON.stringify({
  model: "llama-3.1-8b-instant",
  messages: [
    { role: "system", content: "あなたは優秀なAIです。" },
    { role: "user", content: message }
  ]
});

    const data = await response.json();

    console.log("Groq raw response:", data);

    return res.status(200).json(data);

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
