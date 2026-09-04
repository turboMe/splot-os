import '../index.js';
import { researcherAgent } from '../agents/researcher-agent.js';
import dotenv from 'dotenv';
dotenv.config();

console.log('Researcher agent model ID:', (researcherAgent.model as any)?.modelId || (researcherAgent.model as any)?.id || researcherAgent.model);

async function testGenerate() {
  console.log('Calling researcherAgent.generate...');
  const start = Date.now();
  const res = await researcherAgent.generate('Wypisz dokładnie jedno krótkie zdanie: co to jest Turdus?', { maxSteps: 3 });
  console.log(`Result in ${(Date.now() - start)}ms:`);
  console.log('Text:', res.text);
  process.exit(0);
}

testGenerate().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
