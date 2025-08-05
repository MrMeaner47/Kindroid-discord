import axios, { AxiosError } from "axios";
import {
  ConversationMessage,
  KindroidResponse,
  KindroidAIResult,
} from "./types";

/**
 * Calls the Kindroid AI inference endpoint
 * @param sharedAiCode - shared code for API identification
 * @param conversation - array of conversation messages
 * @param enableFilter - whether to enable NSFW filtering
 * @returns KindroidAIResult indicating success with reply or rate limit
 * @throws Error if the API call fails (except for rate limits)
 */
export async function callKindroidAI(
  sharedAiCode: string,
  conversation: ConversationMessage[],
  enableFilter: boolean = false
): Promise<KindroidAIResult> {
  try {
    if (conversation.length === 0) {
      throw new Error("Conversation array cannot be empty");
    }

    const lastUsername = conversation[conversation.length - 1].username;

    const hashedUsername = Buffer.from(encodeURIComponent(lastUsername))
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 32);

    // ✅ Define the URL here — OUTSIDE the axios call
    const url = process.env.KINDROID_INFER_URL!;

    const response = await axios.post<KindroidResponse>(
  url,
  {
    share_code: sharedAiCode,
    conversation,
    enable_filter: enableFilter,
  },
  {
    headers: {
      Authorization: `Bearer ${process.env.KINDROID_API_KEY!}`,
      "X-Kindroid-Requester": hashedUsername,
      "Content-Type": "application/json",
    },
  }
);
