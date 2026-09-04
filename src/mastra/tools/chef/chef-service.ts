import { randomUUID } from 'node:crypto'
import { getDb, ensureChefIndexes } from './db'
import type { Db } from 'mongodb'
import { generateEmbedding, cosineSimilarity } from '../../lib/embedder'

// Adapter over lib/embedder so existing call sites (embeddingService.generate /
// .cosineSimilarity) keep working. Notes embed semantically; on any failure the
// callers fall back to regex search (try/catch already in place).
const embeddingService = {
  async generate(text: string): Promise<{ embedding: number[] }> {
    return { embedding: await generateEmbedding(text) }
  },
  cosineSimilarity,
}
export type ChefProjectStatus = any; export type ChefEstablishmentType = any; export type ChefEventType = any; export type ChefServiceFormat = any;

// ─── Pipeline state machine (E2) ──────────────────────────────────
// Canonical project statuses driving the Menu Book pipeline. Legacy
// statuses (questionnaire/review/generating/approved/archived) remain valid
// for backward compatibility — these are the new pipeline phases from plan §2.3.
export const CHEF_PIPELINE_STATUSES = [
  'intake',
  'recon',
  'profile_synthesis',
  'checkpoint_profile',
  'menu_draft',
  'critic_gate',
  'checkpoint_menu',
  'recipes',
  'qa_final',
  'render',
  'done',
] as const
export type ChefPipelineStatus = typeof CHEF_PIPELINE_STATUSES[number]

// ─── Types ────────────────────────────────────────────────────────

export interface ChefGuestProfile {
  count?: number
  demographics?: string
  dietaryRestrictions?: string[]
  restrictionPercentage?: number
}

export interface ChefPriceRange {
  tier?: 'budget' | 'mid' | 'premium' | 'luxury'
  currency?: string
  avgMainPrice?: number
}

export interface ChefSeasonality {
  targetSeason?: 'spring' | 'summer' | 'autumn' | 'winter'
  targetMonth?: number
  rotationStrategy?: 'quarterly' | 'monthly' | 'weekly_specials'
}

export interface ChefLocation {
  region?: string
  country?: string
  localIngredients?: boolean
}

export interface ChefIdentity {
  signatureDishes?: string[]
  narrative?: string
  chefPhilosophy?: string
}

export interface ChefOperationalConstraints {
  kitchenCapability?: string[]
  staffLevel?: 'minimal' | 'standard' | 'full_brigade'
  miseEnPlaceSharing?: boolean
}

/** Target execution-difficulty parity vs the establishment's current menu (E2). */
export interface ChefDifficultyTarget {
  /** 1-5; parity ±1 vs current menu's difficulty score. */
  score?: number
  /** Why this target (e.g. "parity ±1 vs current menu score 3 — more interesting effects, same stations"). */
  rationale?: string
}

/** Snapshot reference to the establishment's CURRENT menu, captured during recon (E2). */
export interface ChefCurrentMenuRef {
  url?: string
  format?: 'html' | 'pdf' | 'image' | 'unknown' | string
  avgMainPrice?: number
  currency?: string
  dishCount?: number
  styleNotes?: string
  difficultyScore?: number
  capturedAt?: Date
}

export interface ChefProfile {
  establishmentType: ChefEstablishmentType
  eventType?: ChefEventType
  cuisineTypes: string[]
  cuisineApproach?: 'traditional' | 'modern' | 'fusion' | 'regional'
  serviceFormat?: ChefServiceFormat
  guestProfile?: ChefGuestProfile
  priceRange?: ChefPriceRange
  seasonality?: ChefSeasonality
  location?: ChefLocation
  identity?: ChefIdentity
  operationalConstraints?: ChefOperationalConstraints
  additionalNotes?: string
  /** E2: target difficulty parity vs current menu (from website recon). */
  difficultyTarget?: ChefDifficultyTarget
  /** E2: reference to the establishment's current menu (from website recon). */
  currentMenuRef?: ChefCurrentMenuRef
}

export interface ChefProject {
  id: string
  name: string
  status: ChefProjectStatus
  profile: ChefProfile
  menuVersions: string[]
  currentMenuId?: string
  createdAt: Date
  updatedAt: Date
  createdBy?: string
}

export interface ChefDish {
  name: string
  description: string
  ingredients: string[]
  techniques: string[]
  flavorProfile?: {
    dominant?: string[]
    bridges?: string[]
    family?: string
  }
  textures?: string[]
  temperature?: string
  allergens?: string[]
  dietaryTags?: string[]
  menuEngineering?: {
    predictedQuadrant?: string
    costTier?: string
    marginLever?: string
  }
  pairingWine?: string
  pairingNonAlcoholic?: string
  plateDescription?: string
}

export interface ChefMenuSection {
  name: string
  dishes: ChefDish[]
}

export interface ChefMenu {
  id: string
  projectId: string
  version: number
  title: string
  narrative: string
  sections: ChefMenuSection[]
  metadata?: {
    totalDishes?: number
    cuisineBalance?: Record<string, number>
    allergenMatrix?: Record<string, string[]>
    seasonalIngredients?: string[]
    techniqueDistribution?: Record<string, number>
    temperatureArc?: string[]
    textureVariety?: number
  }
  generatedAt: Date
  sources?: Array<{ notebook?: string; citation?: string }>
}

export interface RecipeIngredient {
  name: string
  quantity: number
  unit: 'g' | 'kg' | 'ml' | 'l' | 'szt' | 'porcji' | string
  notes?: string
}

export interface RecipeStep {
  order: number
  instruction: string
  temperature?: string
  time?: string
}

export interface ChefRecipe {
  id: string
  projectId: string
  dishId?: string
  dishName: string
  yield: {
    amount: number
    unit: 'porcji' | 'kg' | 'l' | string
  }
  components: Array<{
    componentName: string
    ingredients: RecipeIngredient[]
    miseEnPlace: RecipeStep[]
  }>
  serviceSteps: RecipeStep[]
  allergens?: string[]
  equipmentNeeded?: string[]
  createdAt: Date
  updatedAt: Date
}

export interface ChefNote {
  id: string
  projectId?: string
  type: 'preference' | 'pairing' | 'technique' | 'seasonal' | 'feedback' | 'general' | 'nlm_cache'
  topic?: string
  content: string
  embedding?: number[]
  createdAt: Date
  /** For nlm_cache: TTL expiry timestamp */
  expiresAt?: Date
}

// ─── Questionnaire Logic ──────────────────────────────────────────

interface MissingField {
  path: string
  label: string
  priority: 'required' | 'recommended' | 'optional'
  defaultSuggestion?: any
}

const BASE_REQUIRED_FIELDS: Array<{ path: string; label: string }> = [
  { path: 'cuisineTypes', label: 'Cuisine type (e.g. French, Italian, Asian)' },
  { path: 'serviceFormat', label: 'Service format (à la carte, tasting, prix fixe, buffet, family style, stations, canapé)' },
  { path: 'guestProfile.count', label: 'Guest count' },
  { path: 'seasonality.targetSeason', label: 'Target season (spring, summer, autumn, winter)' },
  { path: 'location.region', label: 'Region / location' }
]

const EVENT_REQUIRED_FIELDS: Array<{ path: string; label: string }> = [
  { path: 'eventType', label: 'Event type (wedding, corporate, cocktail, seasonal, private, gala)' },
  { path: 'guestProfile.dietaryRestrictions', label: 'Guest dietary restrictions' },
  { path: 'guestProfile.restrictionPercentage', label: 'Estimated % of guests with dietary restrictions' }
]

const FINE_DINING_FIELDS: Array<{ path: string; label: string }> = [
  { path: 'identity.narrative', label: 'Menu narrative arc (e.g. seasonal journey, terroir, chef memory)' },
  { path: 'identity.chefPhilosophy', label: 'Chef philosophy' }
]

const RECOMMENDED_FIELDS: Array<{ path: string; label: string }> = [
  { path: 'priceRange.tier', label: 'Price range tier (budget, mid, premium, luxury)' },
  { path: 'location.localIngredients', label: 'Priority on local ingredients?' },
  { path: 'operationalConstraints.kitchenCapability', label: 'Kitchen capabilities (grill, sous vide, oven, smoker)' },
  { path: 'operationalConstraints.staffLevel', label: 'Staffing level (minimal, standard, full brigade)' },
  { path: 'identity.signatureDishes', label: 'Signature dishes (anchor dishes that do not rotate)' }
]

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, key) => o?.[key], obj)
}

function deepMerge(target: any, source: any): any {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}

function isEmpty(value: any): boolean {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

function getMissingFields(profile: ChefProfile): MissingField[] {
  const missing: MissingField[] = []

  for (const field of BASE_REQUIRED_FIELDS) {
    if (isEmpty(getNestedValue(profile, field.path))) {
      missing.push({ path: field.path, label: field.label, priority: 'required' })
    }
  }

  if (profile.establishmentType === 'event_catering') {
    for (const field of EVENT_REQUIRED_FIELDS) {
      if (isEmpty(getNestedValue(profile, field.path))) {
        missing.push({ path: field.path, label: field.label, priority: 'required' })
      }
    }
  }

  if (profile.establishmentType === 'fine_dining' || profile.establishmentType === 'upscale') {
    for (const field of FINE_DINING_FIELDS) {
      if (isEmpty(getNestedValue(profile, field.path))) {
        missing.push({ path: field.path, label: field.label, priority: 'recommended' })
      }
    }
  }

  for (const field of RECOMMENDED_FIELDS) {
    if (isEmpty(getNestedValue(profile, field.path))) {
      missing.push({ path: field.path, label: field.label, priority: 'optional' })
    }
  }

  return missing
}

function getDefaultSuggestions(profile: ChefProfile): Record<string, any> {
  const suggestions: Record<string, any> = {}

  if (profile.establishmentType === 'bistro') {
    suggestions.serviceFormat = 'a_la_carte'
    suggestions['priceRange.tier'] = 'mid'
    suggestions['operationalConstraints.miseEnPlaceSharing'] = true
  } else if (profile.establishmentType === 'fine_dining') {
    suggestions.serviceFormat = 'tasting_menu'
    suggestions['priceRange.tier'] = 'luxury'
    suggestions['operationalConstraints.staffLevel'] = 'full_brigade'
  } else if (profile.establishmentType === 'event_catering' && profile.eventType === 'wedding') {
    suggestions.serviceFormat = 'prix_fixe'
    suggestions['guestProfile.restrictionPercentage'] = 30
    suggestions['guestProfile.dietaryRestrictions'] = ['vegetarian', 'gluten_free']
  } else if (profile.establishmentType === 'event_catering' && profile.eventType === 'corporate') {
    suggestions['guestProfile.restrictionPercentage'] = 30
    suggestions['guestProfile.dietaryRestrictions'] = ['vegetarian', 'vegan', 'gluten_free']
  } else if (profile.establishmentType === 'casual') {
    suggestions.serviceFormat = 'a_la_carte'
    suggestions['priceRange.tier'] = 'mid'
  }

  return suggestions
}

function getContextualQuestions(profile: ChefProfile): string[] {
  const questions: string[] = []

  switch (profile.establishmentType) {
    case 'bistro':
      questions.push('How many daily specials do you plan to have in the weekly rotation?')
      questions.push('Is the daily specials board important to the concept?')
      break
    case 'fine_dining':
      questions.push('How many courses should the tasting menu have? (typically 8-16)')
      questions.push('Do you plan to serve amuse-bouche and petit fours?')
      questions.push('What narrative arc do you prefer? (seasonal journey / terroir / memory / ingredient showcase / conceptual)')
      questions.push('Should wine pairing be integrated (two tracks: classic and adventurous)?')
      break
    case 'upscale':
      questions.push('Do you want a mixed format — tasting menu + shorter à la carte?')
      questions.push('How many courses in the tasting menu? (typically 5-7)')
      break
    case 'event_catering':
      if (profile.eventType === 'wedding') {
        questions.push('What wedding format: plated (4-6 courses), buffet, family-style, or cocktail with stations?')
        questions.push('Will there be a cocktail hour before dinner? How many canapés per guest? (typically 3-5)')
        questions.push('Are halal/kosher options required?')
        questions.push('Is a children menu needed?')
      } else if (profile.eventType === 'cocktail') {
        questions.push('How long will the event last? (influences canapé count per guest: 1-2h = 5-8 pcs, 3h+ = 10-15 pcs)')
        questions.push('Is the event stand-up or with seating?')
        questions.push('What ratio of hot/cold canapés do you prefer? (default 50/50)')
      } else if (profile.eventType === 'corporate') {
        questions.push('How long is the service window? (typically 45 minutes for lunch buffet)')
        questions.push('Should the flavor profile be conservative?')
      }
      break
    case 'casual':
      questions.push('Should the menu have a kids / family section?')
      questions.push('How many signature dishes (anchors) should survive every rotation?')
      questions.push('How often do you plan to rotate? (quarterly 30-40% + weekly specials)')
      break
    case 'food_truck':
      questions.push('What is the single signature item defining the concept?')
      questions.push('How many items max? (food truck: 5-8 is optimal)')
      break
    case 'hotel':
      questions.push('Which formats do you support? (breakfast, lunch, dinner, room service, banquets)')
      questions.push('Is an all-day dining menu needed?')
      break
  }

  return questions
}

// ─── Service ──────────────────────────────────────────────────────

export class ChefService {
  private db: Db | null = null
  private static indexesEnsured = false

  private async getDb(): Promise<Db> {
    if (!this.db) {
      this.db = await getDb()
      if (!ChefService.indexesEnsured) {
        await ensureChefIndexes(this.db).catch(err =>
          console.warn('[ChefService] Index creation skipped:', err.message)
        )
        ChefService.indexesEnsured = true
      }
    }
    return this.db
  }

  // ── Projects ──

  async createProject(params: {
    name: string
    establishmentType: ChefEstablishmentType
    eventType?: ChefEventType
    cuisineTypes?: string[]
    serviceFormat?: ChefServiceFormat
    createdBy?: string
  }): Promise<{ project: ChefProject; missingFields: MissingField[]; contextualQuestions: string[]; defaultSuggestions: Record<string, any> }> {
    const db = await this.getDb()
    const id = randomUUID()
    const now = new Date()

    const profile: ChefProfile = {
      establishmentType: params.establishmentType,
      eventType: params.eventType,
      cuisineTypes: params.cuisineTypes ?? [],
      serviceFormat: params.serviceFormat
    }

    const project: ChefProject = {
      id,
      name: params.name,
      status: 'questionnaire',
      profile,
      menuVersions: [],
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy
    }

    await db.collection('chef_projects').insertOne(project)

    return {
      project,
      missingFields: getMissingFields(profile),
      contextualQuestions: getContextualQuestions(profile),
      defaultSuggestions: getDefaultSuggestions(profile)
    }
  }

  async getProject(projectId: string): Promise<ChefProject | null> {
    const db = await this.getDb()
    return db.collection<ChefProject>('chef_projects').findOne({ id: projectId })
  }

  async listProjects(filter?: { status?: ChefProjectStatus }, limit = 10): Promise<ChefProject[]> {
    const db = await this.getDb()
    const query: any = {}
    if (filter?.status) query.status = filter.status
    return db.collection<ChefProject>('chef_projects')
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray()
  }

  async updateProfile(projectId: string, updates: Record<string, any>): Promise<{
    project: ChefProject
    missingFields: MissingField[]
    contextualQuestions: string[]
    defaultSuggestions: Record<string, any>
    isComplete: boolean
  }> {
    const db = await this.getDb()
    const project = await this.getProject(projectId)
    if (!project) throw new Error(`Chef project ${projectId} not found`)

    const updatedProfile = deepMerge(project.profile, updates)
    const now = new Date()

    await db.collection('chef_projects').updateOne(
      { id: projectId },
      { $set: { profile: updatedProfile, updatedAt: now } }
    )

    const missingFields = getMissingFields(updatedProfile)
    const requiredMissing = missingFields.filter(f => f.priority === 'required')

    if (requiredMissing.length === 0 && project.status === 'questionnaire') {
      await db.collection('chef_projects').updateOne(
        { id: projectId },
        { $set: { status: 'review' } }
      )
    }

    const updated = { ...project, profile: updatedProfile, updatedAt: now }
    if (requiredMissing.length === 0) updated.status = 'review'

    return {
      project: updated,
      missingFields,
      contextualQuestions: getContextualQuestions(updatedProfile),
      defaultSuggestions: getDefaultSuggestions(updatedProfile),
      isComplete: requiredMissing.length === 0
    }
  }

  async updateProjectStatus(projectId: string, status: ChefProjectStatus): Promise<void> {
    const db = await this.getDb()
    await db.collection('chef_projects').updateOne(
      { id: projectId },
      { $set: { status, updatedAt: new Date() } }
    )
  }

  // ── Menus ��─

  async saveMenu(menu: Omit<ChefMenu, 'id' | 'generatedAt'>): Promise<ChefMenu> {
    const db = await this.getDb()
    const id = randomUUID()
    const now = new Date()

    const fullMenu: ChefMenu = { ...menu, id, generatedAt: now }
    await db.collection('chef_menus').insertOne(fullMenu)

    await db.collection('chef_projects').updateOne(
      { id: menu.projectId },
      {
        $set: { currentMenuId: id, updatedAt: now },
        $push: { menuVersions: id } as any
      }
    )

    return fullMenu
  }

  async getMenu(menuId: string): Promise<ChefMenu | null> {
    const db = await this.getDb()
    return db.collection<ChefMenu>('chef_menus').findOne({ id: menuId })
  }

  async getMenusByProject(projectId: string): Promise<ChefMenu[]> {
    const db = await this.getDb()
    return db.collection<ChefMenu>('chef_menus')
      .find({ projectId })
      .sort({ version: -1 })
      .toArray()
  }

  async getLatestMenuVersion(projectId: string): Promise<number> {
    const db = await this.getDb()
    const latest = await db.collection<ChefMenu>('chef_menus')
      .findOne({ projectId }, { sort: { version: -1 }, projection: { version: 1 } })
    return latest?.version ?? 0
  }

  // ── Recipes ──

  async saveRecipe(recipeData: Omit<ChefRecipe, 'id' | 'createdAt' | 'updatedAt'>): Promise<ChefRecipe> {
    const db = await this.getDb()
    const id = randomUUID()
    const now = new Date()

    const fullRecipe: ChefRecipe = { ...recipeData, id, createdAt: now, updatedAt: now }
    await db.collection('chef_recipes').insertOne(fullRecipe)

    return fullRecipe
  }

  async getRecipe(projectId: string, dishName: string): Promise<ChefRecipe | null> {
    const db = await this.getDb()
    return db.collection<ChefRecipe>('chef_recipes').findOne({ projectId, dishName })
  }

  async getRecipesByProject(projectId: string): Promise<ChefRecipe[]> {
    const db = await this.getDb()
    return db.collection<ChefRecipe>('chef_recipes')
      .find({ projectId })
      .sort({ dishName: 1 })
      .toArray()
  }

  // ── Notes ──

  async addNote(params: {
    content: string
    type?: ChefNote['type']
    topic?: string
    projectId?: string
  }): Promise<ChefNote> {
    const db = await this.getDb()

    let embedding: number[] | undefined
    try {
      const textToEmbed = `${params.topic ? params.topic + ': ' : ''}${params.content}`
      const result = await embeddingService.generate(textToEmbed)
      embedding = result.embedding
    } catch {
      // Embedding optional — continue without it
    }

    const note: ChefNote = {
      id: randomUUID(),
      projectId: params.projectId,
      type: params.type ?? 'general',
      topic: params.topic,
      content: params.content,
      embedding,
      createdAt: new Date()
    }
    await db.collection('chef_notes').insertOne(note)
    return note
  }

  async searchNotes(query: string, projectId?: string, limit = 5): Promise<ChefNote[]> {
    const db = await this.getDb()

    // Try vector search first, fallback to regex
    try {
      const result = await embeddingService.generate(query)
      const queryEmbedding = result.embedding

      const filter: any = { embedding: { $exists: true }, type: { $ne: 'nlm_cache' } }
      if (projectId) filter.projectId = projectId

      const allNotes = await db.collection<ChefNote>('chef_notes').find(filter).toArray()

      const scored = allNotes
        .map(note => ({
          note,
          score: embeddingService.cosineSimilarity(queryEmbedding, note.embedding!)
        }))
        .filter(s => s.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      if (scored.length > 0) return scored.map(s => s.note)
    } catch {
      // Embedding unavailable — fall through to regex
    }

    // Regex fallback
    const filter: any = {
      type: { $ne: 'nlm_cache' },
      $or: [
        { content: { $regex: query, $options: 'i' } },
        { topic: { $regex: query, $options: 'i' } }
      ]
    }
    if (projectId) filter.projectId = projectId
    return db.collection<ChefNote>('chef_notes')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  }

  // ── NotebookLM Cache ──

  private static readonly NLM_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

  async getCachedNlmResult(cacheKey: string): Promise<string | null> {
    const db = await this.getDb()
    const cached = await db.collection<ChefNote>('chef_notes').findOne({
      type: 'nlm_cache',
      topic: cacheKey,
      expiresAt: { $gt: new Date() }
    })
    return cached?.content ?? null
  }

  async setCachedNlmResult(cacheKey: string, content: string): Promise<void> {
    const db = await this.getDb()
    await db.collection('chef_notes').updateOne(
      { type: 'nlm_cache', topic: cacheKey },
      {
        $set: {
          id: randomUUID(),
          type: 'nlm_cache',
          topic: cacheKey,
          content,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + ChefService.NLM_CACHE_TTL_MS)
        }
      },
      { upsert: true }
    )
  }
}
