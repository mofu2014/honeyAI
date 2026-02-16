// api/chat.js
// SambaNova Cloud (Llama 3.1) を使う設定だみつ！
// 現在、無料かつ非常に高いレートリミットで提供されています。

export const config = {
  runtime: "edge",
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, systemPrompt, maxTokens } = await req.json();
    const apiKey = process.env.SAMBANOVA_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "サーバー設定エラー: SAMBANOVA_API_KEYがありません" }), { status: 500 });
    }

    // SambaNova APIのエンドポイント
    const url = "https://api.sambanova.ai/v1/chat/completions";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt || "あなたは親切なAIです。" },
          ...messages
        ],
        // 最速・最強のモデル: Meta-Llama-3.1-70B-Instruct
        // (405Bは重いかもしれないので、70Bがおすすめ)
        model: "Meta-Llama-3.1-70B-Instruct",
        stream: true,
        temperature: 0.6,
        max_tokens: parseInt(maxTokens) || 4096
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return new Response(JSON.stringify(errorData), { status: response.status });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = ""; 
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          
          // 最後の行は不完全かもしれないのでバッファに残す
          buffer = lines.pop(); 

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine === "data: [DONE]") continue;
            
            if (trimmedLine.startsWith("data: ")) {
              try {
                const json = JSON.parse(trimmedLine.substring(6));
                const content = json.choices[0]?.delta?.content || "";
                if (content) {
                  controller.enqueue(encoder.encode(content));
                }
              } catch (e) { /* 無視 */ }
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
