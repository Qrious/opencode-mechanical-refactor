import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

export type Client = OpencodeClient;

export function createClient(baseUrl: string): Client {
  return createOpencodeClient({ baseUrl });
}

export async function createSession(client: Client): Promise<string> {
  const { data } = await client.session.create();
  if (!data) throw new Error("Failed to create session");
  return data.id;
}

export async function modifyFile(
  client: Client,
  sessionId: string,
  prompt: string,
  filePath: string,
  fileContents: string,
): Promise<string> {
  const fullPrompt = [
    prompt,
    "",
    `File: ${filePath}`,
    "```csharp",
    fileContents,
    "```",
    "",
    "Return ONLY the modified file contents, wrapped in a single ```csharp code block. Do not include any explanation.",
  ].join("\n");

  const { data } = await client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text: fullPrompt }],
    },
  });

  if (!data) throw new Error("No response from LLM");
  return extractCode(data.parts);
}

function extractCode(parts: any[]): string {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    }
  }
  const text = textParts.join("\n");

  const match = text.match(/```(?:csharp|cs)?\s*\n([\s\S]*?)```/);
  if (match) {
    return match[1].trimEnd() + "\n";
  }

  return text.trimEnd() + "\n";
}
