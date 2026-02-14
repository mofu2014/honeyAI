// api/chat.js
const Groq = require('groq-sdk');

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { messages, systemPrompt } = req.body;

        const conversation = [
            { 
                role: "system", 
                content: systemPrompt 
            },
            ...messages
        ];

        const completion = await groq.chat.completions.create({
            messages: conversation,
            model: "llama-3.3-70b-versatile",
            temperature: 0.7,
        });

        const reply = completion.choices[0]?.message?.content || "返答がないみつ...";
        return res.status(200).json({ reply });

    } catch (error) {
        console.error('Groq Error:', error);
        return res.status(500).json({ error: error.message });
    }
};
