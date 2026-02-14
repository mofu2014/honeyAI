// api/image.js
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt } = req.body;

    // ここを修正！画像で見せてくれた「HF_API_KEY」を読み込むようにしました
    const apiKey = process.env.HF_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'APIキーが見つかりません。コード内の変数名とVercelの環境変数名(HF_API_KEY)が一致しているか確認してください。' });
    }

// api/image.js の中で
const model = "Sunanda-Das/new-text-to-image-v4.2";

    try {
        console.log(`Generating image for: ${prompt}`);

        const response = await fetch(
            `https://api-inference.huggingface.co/models/${model}`,
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                method: "POST",
                body: JSON.stringify({ inputs: prompt }),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Hugging Face API Error:", errorText);
            
            if (errorText.includes("loading")) {
                return res.status(503).json({ error: 'モデルを起動中だみつ...。20秒くらい待ってからもう一度押してね！' });
            }
            throw new Error(`API Error: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = `data:image/jpeg;base64,${buffer.toString('base64')}`;

        return res.status(200).json({ image: base64Image });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: `画像生成エラー: ${error.message}` });
    }
};
