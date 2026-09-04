import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getBudgetTracker } from '../../services/budget-tracker.js';
import { fetchWithDeadline } from '../../lib/http-deadline.js';

/**
 * reviews_google_place — restaurant reviews via the Google Places API (New).
 *
 * Requires GOOGLE_MAPS_API_KEY (Places API New + billing enabled in GCP).
 * Without a key the tool DEGRADES GRACEFULLY: returns success:false with degraded:true
 * and a hint for chefAgent to gather reviews by delegating to researcherAgent
 * (PSEV: TripAdvisor / Google / blogs).
 *
 * Endpoint: POST https://places.googleapis.com/v1/places:searchText
 * Headers: X-Goog-Api-Key, X-Goog-FieldMask
 */

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.primaryType',
  'places.reviews',
].join(',');

export const reviewsGooglePlaceTool = createTool({
  id: 'reviews_google_place',
  description:
    'Fetches a restaurant rating and reviews from the Google Places API (New). Provide the venue name and city. Returns rating, review count, price level and up to 5 recent reviews. Without GOOGLE_MAPS_API_KEY it degrades — then gather reviews by delegating to researcherAgent.',
  inputSchema: z.object({
    query: z
      .string()
      .describe('Venue name + city, e.g. "Restauracja Bernard Wrocław" or "Pod Fredrą Wrocław"'),
    languageCode: z.string().optional().default('pl').describe('Review language code (default pl)'),
    maxReviews: z.number().int().min(1).max(5).optional().default(5).describe('Max number of reviews (1-5)'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    degraded: z.boolean().optional().describe('true = no key, use researcherAgent'),
    place: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        address: z.string().optional(),
        rating: z.number().optional(),
        userRatingCount: z.number().optional(),
        priceLevel: z.string().optional(),
        primaryType: z.string().optional(),
      })
      .optional(),
    reviews: z
      .array(
        z.object({
          author: z.string().optional(),
          rating: z.number().optional(),
          text: z.string().optional(),
          publishTime: z.string().optional(),
        }),
      )
      .optional(),
    hint: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        degraded: true,
        hint: 'Missing GOOGLE_MAPS_API_KEY. Gather reviews via delegate_task → researcherAgent (PSEV: TripAdvisor / Google / blogs).',
      };
    }

    // Recon cost guard (E3, R4): stop hitting the metered Places API once the
    // daily budget is exhausted — degrade to the researcher instead.
    const budget = getBudgetTracker();
    if (budget.isOverBudget('places')) {
      return {
        success: false,
        degraded: true,
        hint: 'Daily Places API budget exhausted (PLACES_DAILY_LIMIT). Gather reviews via delegate_task → researcherAgent.',
      };
    }

    try {
      const res = await fetchWithDeadline(PLACES_ENDPOINT, {
        method: 'POST',
        timeoutMs: 20_000,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: context.query,
          languageCode: context.languageCode,
          maxResultCount: 1,
        }),
      });

      // A metered request was consumed regardless of the HTTP status.
      budget.recordRequest('places', 'places:searchText');

      if (!res.ok) {
        const body = await res.text();
        return {
          success: false,
          error: `Places API ${res.status}: ${body.slice(0, 300)}`,
          hint: res.status === 403
            ? 'Check that "Places API (New)" is enabled and billing is active in GCP. Fallback: researcherAgent.'
            : 'Fallback: gather reviews via delegate_task → researcherAgent.',
        };
      }

      const data: any = await res.json();
      const place = data?.places?.[0];
      if (!place) {
        return {
          success: false,
          error: `No venue found for query "${context.query}".`,
          hint: 'Try refining the name + city, or use researcherAgent.',
        };
      }

      const reviews = (place.reviews ?? [])
        .slice(0, context.maxReviews)
        .map((r: any) => ({
          author: r?.authorAttribution?.displayName,
          rating: r?.rating,
          text: r?.text?.text ?? r?.originalText?.text,
          publishTime: r?.publishTime,
        }));

      return {
        success: true,
        place: {
          id: place.id,
          name: place?.displayName?.text,
          address: place.formattedAddress,
          rating: place.rating,
          userRatingCount: place.userRatingCount,
          priceLevel: place.priceLevel,
          primaryType: place.primaryType,
        },
        reviews,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message,
        hint: 'Fallback: gather reviews via delegate_task → researcherAgent.',
      };
    }
  },
});
