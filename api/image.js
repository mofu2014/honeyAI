// api/image.js
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt } = req.body;
    const apiKey = process.env.HF_API_KEY;

    if (!apiKey) {
        console.error("HF_API_KEY missing");
        return res.status(500).json({ error: 'APIキー設定エラー: HF_API_KEYがありません' });
    }

    // 無料枠で最も動きやすい軽量モデルを使用
    const model = "runwayml/stable-diffusion-v1-5";

    try {
        console.log(`Generating image for: ${prompt}`);

        const response = await fetch(
            `https://api-inference.huggingface.co/models/${model}`,
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "x-wait-for-model": "true" // モデル起動待ち
                },
                method: "POST",
                body: JSON.stringify({ inputs: prompt }),
            }
        );

        // エラーハンドリング
        if (!response.ok) {
            const errorText = await response.text();
            console.error("HF API Error:", errorText);
            
            // よくあるエラーを親切に返す
            if (response.status === 503 || errorText.includes("loading")) {
                return res.status(503).json({ error: "モデル起動中です。もう一度ボタンを押してください！" });
            }
            if (response.status === 410) {
                return res.status(410).json({ error: "このモデルは現在利用できません(410)。HuggingFace側の制限です。" });
            }
            return res.status(response.status).json({ error: `画像生成失敗: ${errorText}` });
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = `data:image/jpeg;base64,${buffer.toString('base64')}`;

        return res.status(200).json({ image: base64Image });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: error.message });
    }
};
