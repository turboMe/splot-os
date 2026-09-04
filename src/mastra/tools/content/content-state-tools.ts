/**
 * Content pipeline state-machine tools.
 * Clone of the chef state tools (chef-tools.ts): start / get / list / set_status.
 * These let the contentAgent hold resumable state across the pipeline phases.
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { ContentService, CONTENT_PIPELINE_STATUSES } from './content-service'

export const contentStartProjectTool = createTool({
  id: 'content_start_project',
  description:
    'Starts a new content project (batch of posts on IG/LinkedIn/TikTok). Creates the project in "intake" status and returns its ID. Use this at the start of each content production session.',
  inputSchema: z.object({
    name: z.string().describe('Project name (e.g., "Content week 25/2026 — food cost")'),
    brief: z.string().describe('Brief: topic/angle/occasion for this batch of posts'),
    targets: z.object({
      linkedin: z.boolean().optional(),
      instagram: z.boolean().optional(),
      tiktok: z.boolean().optional(),
    }).optional().describe('Target channels (defaults to all three)'),
    weekDate: z.string().optional().describe('Week anchor, e.g., "2026-W25", or batch date'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    project: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const content = new ContentService()
      const project = await content.createProject({
        name: context.name,
        brief: context.brief,
        targets: context.targets,
        weekDate: context.weekDate,
      })
      return { success: true, project }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

export const contentGetProjectTool = createTool({
  id: 'content_get_project',
  description: 'Retrieves details of a content project including brief, channels, and current pipeline status.',
  inputSchema: z.object({
    projectId: z.string().describe('UUID of the content project'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    project: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const content = new ContentService()
      const project = await content.getProject(context.projectId)
      if (!project) return { success: false, error: `Content project ${context.projectId} not found.` }
      return { success: true, project }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

export const contentListProjectsTool = createTool({
  id: 'content_list_projects',
  description: 'Returns a list of content projects with their statuses. Optionally filter by status.',
  inputSchema: z.object({
    status: z.enum(CONTENT_PIPELINE_STATUSES).optional().describe('Filter by pipeline status'),
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number().optional(),
    projects: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const content = new ContentService()
      const projects = await content.listProjects(
        context.status ? { status: context.status } : undefined,
        context.limit ?? 10,
      )
      return {
        success: true,
        count: projects.length,
        projects: projects.map(p => ({
          id: p.id,
          name: p.name,
          status: p.status,
          targets: p.targets,
          weekDate: p.weekDate,
          updatedAt: p.updatedAt,
        })),
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

export const contentSetProjectStatusTool = createTool({
  id: 'content_set_project_status',
  description:
    'Sets the project status in the pipeline state machine. Call on every phase transition to keep the state resumable and auditable. Allowed statuses: intake, research, strategy, checkpoint_strategy, draft, critique, art_direction, assemble, checkpoint_review, ship, done.',
  inputSchema: z.object({
    projectId: z.string().describe('UUID of the content project'),
    status: z.enum(CONTENT_PIPELINE_STATUSES).describe('New pipeline phase status'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    projectId: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const content = new ContentService()
      const project = await content.getProject(context.projectId)
      if (!project) return { success: false, error: `Content project ${context.projectId} not found.` }
      await content.updateProjectStatus(context.projectId, context.status)
      return { success: true, projectId: context.projectId, status: context.status }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})
