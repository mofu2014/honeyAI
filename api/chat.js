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
        // フロントエンドから「性格(systemPrompt)」と「会話履歴(messages)」を受け取る
        const { messages, systemPrompt } = req.body;

        // Groqに送るメッセージリストを作成
        // 1. 最初に性格設定(system)を入れる
        // 2. その後にこれまでの会話履歴(user/assistant)を続ける
        const conversation = [
            { 
                role: "system", 
                content: systemPrompt || "あなたは親切なAIアシスタント「HoneyAI」です。語尾に「～だみつ」や「～ハニー」をつけて話してください。" 
            },
            ...messages
        ];

        const completion = await groq.chat.completions.create({
            messages: conversation,
            model: "llama-3.3-70b-versatile", // 最新モデル
            temperature: 0.7, // 創造性の調整（少し高めで人間らしく）
        });

        const reply = completion.choices[0]?.message?.content || "（反応がないみたい...）";
        
        return res.status(200).json({ reply });

    } catch (error) {
        console.error('Groq API Error:', error);
        return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
};
