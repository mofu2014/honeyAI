// api/chat.js
import Groq from "groq-sdk";

// 環境変数からAPIキーを取得
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

export default async function handler(req, res) {
    // POSTリクエスト以外は拒否
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { message } = req.body;

    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "あなたは役に立つアシスタントです。日本語で答えてください。" },
                { role: "user", content: message }
            ],
model: "llama-3.3-70b-versatile",
        });

        const reply = completion.choices[0]?.message?.content || "返答がありませんでした";
        
        return res.status(200).json({ reply });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
