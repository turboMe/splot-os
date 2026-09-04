import { getSkillRegistry } from '../services/skill-registry.js';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function checkSkills() {
  const registry = getSkillRegistry();
  // Skills are in src/mastra/_skills/
  const skillsDir = resolve(__dirname, '..', '_skills');
  console.log(`Scanning: ${skillsDir}`);
  
  await registry.initialize(skillsDir);
  
  const skills = registry.list({ category: 'knowledge' });
  console.log('\n--- Knowledge Skills Indexed ---');
  if (skills.length === 0) {
    console.log('No knowledge skills found!');
  }
  skills.forEach(s => console.log(`- ${s.name}: ${s.description.substring(0, 50)}...`));
  console.log('-------------------------------');
  console.log(`Total Knowledge Skills: ${skills.length}`);
}

checkSkills().catch(console.error);
