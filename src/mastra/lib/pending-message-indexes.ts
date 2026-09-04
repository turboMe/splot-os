import type { Db, IndexDescription } from 'mongodb';

export const PENDING_MESSAGE_CLAIM_INDEXES: IndexDescription[] = [
  {
    name: 'pending_claim_task_v1',
    key: {
      taskId: 1,
      status: 1,
      targetAgentId: 1,
      urgent: -1,
      createdAt: 1,
      id: 1,
      expiresAt: 1,
    },
  },
  {
    name: 'pending_claim_thread_v1',
    key: {
      threadId: 1,
      status: 1,
      targetAgentId: 1,
      urgent: -1,
      createdAt: 1,
      id: 1,
      expiresAt: 1,
    },
  },
  {
    name: 'pending_claim_task_thread_v1',
    key: {
      taskId: 1,
      threadId: 1,
      status: 1,
      targetAgentId: 1,
      urgent: -1,
      createdAt: 1,
      id: 1,
      expiresAt: 1,
    },
  },
];

export async function ensurePendingMessageClaimIndexes(db: Db): Promise<void> {
  await db.collection('pending_user_messages').createIndexes(
    PENDING_MESSAGE_CLAIM_INDEXES,
  );
}
