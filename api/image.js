// api/chat.js
const Groq = require('groq-sdk');

module.exports = async function handler(req, res) {
    // APIキーの確認
    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: "Server Error: GROQ_API_KEY is missing." });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { messages, systemPrompt } = req.body;

        // システム設定と会話履歴を結合
        const conversation = [
            { 
                role: "system", 
                content: systemPrompt || "あなたは親切なAIです。" 
            },
            ...(messages || [])
        ];

        const completion = await groq.chat.completions.create({
            messages: conversation,
            model: "llama-3.3-70b-versatile",
            temperature: 0.7,
            max_tokens: 1024,
        });

        const reply = completion.choices[0]?.message?.content || "(返答なし)";
        return res.status(200).json({ reply });

    } catch (error) {
        console.error('Groq Error:', error);
        return res.status(500).json({ error: error.message });
    }
};
