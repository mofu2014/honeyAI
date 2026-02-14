// api/chat.js
export const config = {
  runtime: "edge", // Vercelのエッジ機能を使う
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, systemPrompt, modelId } = await req.json();
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "APIキーが設定されていません" }), { status: 500 });
    }

    // Groq APIへリクエスト
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ],
        model: modelId || "llama-3.3-70b-versatile",
        stream: true,
        temperature: 0.6, // 少し下げて発言を安定させる
        max_tokens: 4096  // 長文でも切れないように確保
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return new Response(JSON.stringify(errorData), { status: response.status });
    }

    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = ""; // ★ここが重要：データを一時保存する場所

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // 届いたデータを文字に変換してバッファに追加
          buffer += decoder.decode(value, { stream: true });
          
          // 改行で行ごとに分ける
          const lines = buffer.split("\n");
          
          // ★最後の行は「まだ途中」の可能性が高いので、次の処理に持ち越す（ここが途切れ防止の肝！）
          buffer = lines.pop();

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine === "data: [DONE]") continue;
            
            if (trimmedLine.startsWith("data: ")) {
              try {
                // "data: " の後ろのJSONを取り出す
                const json = JSON.parse(trimmedLine.substring(6));
                const content = json.choices[0]?.delta?.content || "";
                if (content) {
                  controller.enqueue(encoder.encode(content));
                }
              } catch (e) {
                // JSONが壊れていても無視して次へ（止まらないようにする）
                console.error("JSON Parse Error:", e);
              }
            }
          }
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { 
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
