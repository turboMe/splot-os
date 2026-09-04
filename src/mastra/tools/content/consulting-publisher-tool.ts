/**
 * Consulting Knowledge Base Publisher Tool
 *
 * Publishes bilingual (PL + EN) articles to GastroBridge-Consulting Knowledge Base (/wiedza)
 * and sends an instant Telegram notification with live links.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

function calculateReadTime(text?: string): string {
  if (!text) return '5 min';
  const words = text.trim().split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min`;
}

function resolveApiConfig() {
  const apiUrl = process.env.CONSULTING_API_URL || 'https://consulting.gastrobridge.com/api/wiedza';
  const apiSecret = process.env.AGENT_API_SECRET;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.N8N_TELEGRAM_CHAT_ID || '578179283';
  return { apiUrl, apiSecret, botToken, chatId };
}

async function sendTelegramAlert(
  botToken: string,
  chatId: string,
  article: {
    title: string;
    titleEN: string;
    category: string;
    categoryEN: string;
    readTime: string;
    tags: string[];
    slug: string;
    author: { name: string; role: string };
  },
  urls: { pl: string; en: string },
): Promise<{ sent: boolean; error?: string; messageId?: number }> {
  if (!botToken) {
    return { sent: false, error: 'Missing TELEGRAM_BOT_TOKEN' };
  }

  const tagsFormatted = (article.tags || []).map((t) => `#${t.replace(/\s+/g, '_')}`).join(' ');
  const targetUrl = urls?.pl || `https://consulting.gastrobridge.com/wiedza/${article.slug}`;

  const messageText = `🚀 *Nowy artykuł opublikowany w Bazie Wiedzy!*

📖 *Tytuł PL:* ${article.title}
🇬🇧 *Title EN:* ${article.titleEN}
📂 *Kategoria:* ${article.category} (${article.categoryEN})
⏱️ *Czas czytania:* ${article.readTime}
🏷️ *Tagi:* ${tagsFormatted || 'brak'}
✍️ *Autor:* ${article.author.name} (${article.author.role})

🔗 *Zobacz artykuł na żywo:*
${targetUrl}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      }),
    });

    const data = (await res.json()) as { ok: boolean; description?: string; result?: { message_id?: number } };
    if (!data.ok) {
      return { sent: false, error: data.description || 'Unknown Telegram API error' };
    }
    return { sent: true, messageId: data.result?.message_id };
  } catch (err) {
    return { sent: false, error: (err as Error).message };
  }
}

export const consultingPublishArticleTool = createTool({
  id: 'consulting_publish_article',
  description:
    'Publishes a bilingual (Polish + English) article to the GastroBridge-Consulting Knowledge Base (/wiedza) ' +
    'and automatically sends a notification with live links to Telegram. Requires full PL and EN content.',
  inputSchema: z.object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be kebab-case (e.g., jak-zoptymalizowac-food-cost)')
      .describe('URL slug identifier for the article.'),
    category: z.string().min(2).describe('Category in Polish, e.g. "Menu & koszty".'),
    categoryEN: z.string().min(2).describe('Category in English, e.g. "Menu & Costs".'),
    title: z.string().min(3).describe('Article title in Polish.'),
    titleEN: z.string().min(3).describe('Article title in English (mandatory).'),
    excerpt: z.string().min(10).describe('Short summary / excerpt in Polish (1-3 sentences).'),
    excerptEN: z.string().min(10).describe('Short summary / excerpt in English (1-3 sentences, mandatory).'),
    content: z.string().min(50).describe('Full markdown article body in Polish.'),
    contentEN: z.string().min(50).describe('Full markdown article body in English (mandatory).'),
    readTime: z.string().optional().describe('Reading time in Polish, e.g. "6 min" (auto-calculated if omitted).'),
    readTimeEN: z.string().optional().describe('Reading time in English, e.g. "6 min" (auto-calculated if omitted).'),
    tags: z.array(z.string()).optional().default([]).describe('Tags for categorization and search.'),
    author: z
      .object({
        name: z.string().default('Zespół GastroBridge'),
        role: z.string().default('Praktycy gastronomii & Inżynierowie AI'),
      })
      .optional()
      .default({
        name: 'Zespół GastroBridge',
        role: 'Praktycy gastronomii & Inżynierowie AI',
      }),
    featured: z.boolean().optional().default(false).describe('Whether to pin as featured article.'),
    status: z.enum(['published', 'draft']).optional().default('published').describe('Article publication status.'),
    updateExisting: z
      .boolean()
      .optional()
      .default(false)
      .describe('Set to true to update an existing article via PUT /api/wiedza/[slug].'),
    sendTelegram: z
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to send an instant Telegram notification upon publication.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    slug: z.string(),
    urls: z.object({
      pl: z.string(),
      en: z.string(),
    }),
    telegram: z.object({
      sent: z.boolean(),
      error: z.string().optional(),
      messageId: z.number().optional(),
    }),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const { apiUrl, apiSecret, botToken, chatId } = resolveApiConfig();

      const readTime = context.readTime || calculateReadTime(context.content);
      const readTimeEN = context.readTimeEN || calculateReadTime(context.contentEN);
      const author = {
        name: context.author?.name || 'Zespół GastroBridge',
        role: context.author?.role || 'Praktycy gastronomii & Inżynierowie AI',
      };

      const payload = {
        slug: context.slug.trim(),
        category: context.category.trim(),
        categoryEN: context.categoryEN.trim(),
        title: context.title.trim(),
        titleEN: context.titleEN.trim(),
        excerpt: context.excerpt.trim(),
        excerptEN: context.excerptEN.trim(),
        content: context.content.trim(),
        contentEN: context.contentEN.trim(),
        readTime,
        readTimeEN,
        tags: context.tags || [],
        author,
        featured: Boolean(context.featured),
        status: context.status || 'published',
      };

      const targetEndpoint = context.updateExisting
        ? `${apiUrl.replace(/\/$/, '')}/${payload.slug}`
        : apiUrl;
      const httpMethod = context.updateExisting ? 'PUT' : 'POST';

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiSecret) {
        headers['Authorization'] = `Bearer ${apiSecret}`;
      }

      const res = await fetch(targetEndpoint, {
        method: httpMethod,
        headers,
        body: JSON.stringify(payload),
      });

      const responseText = await res.text();
      let responseData: any;
      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = { message: responseText };
      }

      if (!res.ok) {
        return {
          success: false,
          slug: payload.slug,
          urls: { pl: '', en: '' },
          telegram: { sent: false, error: 'Publish failed' },
          message: `API request failed with status ${res.status}`,
          error: responseData?.error || responseData?.message || responseText,
        };
      }

      const urls = responseData?.urls || {
        pl: `https://consulting.gastrobridge.com/wiedza/${payload.slug}`,
        en: `https://consulting.gastrobridge.com/wiedza/${payload.slug}`,
      };

      let telegramResult: { sent: boolean; error?: string; messageId?: number } = {
        sent: false,
        error: 'Disabled by caller',
      };
      if (context.sendTelegram !== false && botToken) {
        telegramResult = await sendTelegramAlert(
          botToken,
          chatId,
          { ...payload, readTime, author },
          urls,
        );
      }

      return {
        success: true,
        slug: payload.slug,
        urls,
        telegram: telegramResult,
        message: 'Article published and notified successfully',
      };
    } catch (err) {
      return {
        success: false,
        slug: context.slug,
        urls: { pl: '', en: '' },
        telegram: { sent: false, error: (err as Error).message },
        message: 'Unexpected error during publishing',
        error: (err as Error).message,
      };
    }
  },
});
