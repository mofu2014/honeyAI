// api/image.js
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt } = req.body;
    
    // APIキーの確認
    const apiKey = process.env.HF_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'サーバー設定エラー: HF_API_KEYが見つかりません' });
    }

    // モデル: 最新の高速モデル FLUX.1-schnell を指定
    const model = "black-forest-labs/FLUX.1-schnell";

    try {
        console.log(`[Image Generation] Prompt: ${prompt}, Model: ${model}`);

        const response = await fetch(
            `https://api-inference.huggingface.co/models/${model}`,
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "x-wait-for-model": "true" // 重要: モデル起動待ちをする設定
                },
                method: "POST",
                body: JSON.stringify({ 
                    inputs: prompt
                }),
            }
        );

        // エラーハンドリング
        if (!response.ok) {
            const errorText = await response.text();
            console.error("[HF API Error]", response.status, errorText);
            
            // 410や403などの詳細をフロントエンドに返す
            return res.status(response.status).json({ 
                error: `API Error ${response.status}: ${errorText}` 
            });
        }

        // 成功した場合: 画像データ(blob)を取得してBase64化
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = `data:image/jpeg;base64,${buffer.toString('base64')}`;

        return res.status(200).json({ image: base64Image });

    } catch (error) {
        console.error("[Server Internal Error]", error);
        return res.status(500).json({ error: error.message });
    }
};
