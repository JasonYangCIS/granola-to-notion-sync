import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints.js";
import type { GranolaNote } from "../types.js";

type RichText = {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
};

const MAX_RICH_TEXT_LENGTH = 2000;

/**
 * Convert a Granola note (from API) into Notion blocks.
 */
export function convertToNotionBlocks(note: GranolaNote): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [];

  blocks.push(...buildMetadataHeader(note));

  // AI Summary
  const summaryText = note.summary_markdown || note.summary_text;
  if (summaryText?.trim()) {
    blocks.push(...textToBlocks(summaryText));
  } else {
    blocks.push({
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: "(No summary available)" },
            annotations: { italic: true },
          },
        ],
      },
    } as BlockObjectRequest);
  }

  return blocks;
}

function buildMetadataHeader(note: GranolaNote): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [];

  const dateStr = formatMeetingTime(note);
  if (dateStr) {
    blocks.push({
      type: "callout",
      callout: {
        rich_text: [{ type: "text", text: { content: dateStr } }],
        icon: { type: "emoji", emoji: "📅" },
      },
    } as BlockObjectRequest);
  }

  const attendees = formatAttendees(note);
  if (attendees) {
    blocks.push({
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: "Attendees: " },
            annotations: { bold: true },
          },
          { type: "text", text: { content: attendees } },
        ],
      },
    } as BlockObjectRequest);
  }

  if (blocks.length > 0) {
    blocks.push({ type: "divider", divider: {} } as BlockObjectRequest);
  }

  return blocks;
}

function formatMeetingTime(note: GranolaNote): string | null {
  const startStr = note.calendar_event?.scheduled_start_time;
  if (!startStr) {
    const d = new Date(note.created_at);
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  const start = new Date(startStr);
  const endStr = note.calendar_event?.scheduled_end_time;
  const end = endStr ? new Date(endStr) : null;

  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };

  const datePart = start.toLocaleDateString("en-US", dateOpts);
  const startTime = start.toLocaleTimeString("en-US", timeOpts);
  const endTime = end?.toLocaleTimeString("en-US", timeOpts);

  return endTime
    ? `${datePart} \u2022 ${startTime} - ${endTime}`
    : `${datePart} \u2022 ${startTime}`;
}

function formatAttendees(note: GranolaNote): string | null {
  if (note.attendees?.length) {
    return note.attendees.map((a) => a.name || a.email).join(", ");
  }
  if (note.calendar_event?.invitees?.length) {
    return note.calendar_event.invitees.map((i) => i.email).join(", ");
  }
  return null;
}

function textToBlocks(text: string): BlockObjectRequest[] {
  const lines = text.split("\n");
  if (lines.length === 0) return [];

  const blocks: BlockObjectRequest[] = [];
  // Stack tracks ancestor list items so children can be nested under them.
  // Each entry: { block (the Notion block object), indent (char count of leading whitespace) }
  const listStack: { block: any; indent: number }[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const trimmed = line.trim();

    // Detect bulleted list items and preserve their indentation level
    const listMatch = line.match(/^(\s*)([-•*])\s+(.*)/);

    if (listMatch) {
      const indent = listMatch[1].length;
      const content = listMatch[3];

      const block = {
        type: "bulleted_list_item" as const,
        bulleted_list_item: { rich_text: chunkText(content) } as any,
      };

      // Pop stack entries at the same or deeper indent — they can't be parents
      while (listStack.length > 0 && listStack[listStack.length - 1].indent >= indent) {
        listStack.pop();
      }

      if (listStack.length > 0) {
        // Nest as a child of the closest shallower item
        const parent = listStack[listStack.length - 1].block;
        if (!parent.bulleted_list_item.children) {
          parent.bulleted_list_item.children = [];
        }
        parent.bulleted_list_item.children.push(block);
      } else {
        blocks.push(block as BlockObjectRequest);
      }

      listStack.push({ block, indent });
    } else {
      // Non-list line resets nesting context
      listStack.length = 0;

      if (trimmed.startsWith("### ")) {
        blocks.push({
          type: "heading_3",
          heading_3: { rich_text: chunkText(trimmed.slice(4)) },
        } as BlockObjectRequest);
      } else if (trimmed.startsWith("## ")) {
        blocks.push({
          type: "heading_2",
          heading_2: { rich_text: chunkText(trimmed.slice(3)) },
        } as BlockObjectRequest);
      } else if (trimmed.startsWith("# ")) {
        blocks.push({
          type: "heading_1",
          heading_1: { rich_text: chunkText(trimmed.slice(2)) },
        } as BlockObjectRequest);
      } else {
        blocks.push({
          type: "paragraph",
          paragraph: { rich_text: chunkText(trimmed) },
        } as BlockObjectRequest);
      }
    }
  }

  return blocks;
}

function chunkText(text: string): RichText[] {
  return chunkString(text).map((chunk) => ({
    type: "text",
    text: { content: chunk },
  }));
}

function chunkString(text: string): string[] {
  if (text.length <= MAX_RICH_TEXT_LENGTH) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_RICH_TEXT_LENGTH) {
    chunks.push(text.slice(i, i + MAX_RICH_TEXT_LENGTH));
  }
  return chunks;
}
