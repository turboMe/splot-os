# Specyfikacja narzędzi dla lokalnego Meta Agenta na Ubuntu

Dokument dla deva. Cel: zaprojektować bezpieczny zestaw narzędzi, dzięki którym lokalny meta-agent może wykonywać zadania na komputerze z Ubuntu, korzystać z terminala, czytać projekty, diagnozować usługi, uruchamiać lokalne modele LLM, pracować z n8n, MongoDB, Redis, Dockerem i zarządzać podzadaniami.

## 1. Główna zasada architektoniczna

Nie dawaj agentowi jednego gołego narzędzia typu:

```ts
execute_shell(command: string)
```

To jest zbyt ryzykowne. Agent może przypadkowo wygenerować komendę destrukcyjną, np. usunięcie plików, restart usług, zmianę uprawnień albo wykonanie zewnętrznego skryptu.

Zamiast tego agent powinien dostać zestaw małych, kontrolowanych narzędzi:

```text
Meta Agent
   |
   +-- read-only tools       -> może używać samodzielnie
   +-- safe action tools     -> może używać samodzielnie tylko w dozwolonych katalogach
   +-- risky action tools    -> wymaga potwierdzenia użytkownika albo trybu dry-run
   +-- forbidden actions     -> blokowane zawsze
```

Najlepszy model bezpieczeństwa:

```text
Najpierw obserwuj.
Potem diagnozuj.
Potem proponuj zmianę.
Dopiero na końcu wykonuj zmianę.
Ryzykowne akcje zawsze wymagają zatwierdzenia.
```

## 2. Różnica między modelem, agentem i narzędziem

### Model

Model to silnik LLM, np. lokalny model w Ollama:

```text
gemma4:26b
huihui_ai/qwen3.5-abliterated:35b
```

### Agent

Agent to konfiguracja użycia modelu:

```ts
type AgentConfig = {
  name: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  memoryScope: string;
  outputFormat?: 'json' | 'markdown' | 'text';
};
```

Przykład:

```ts
const codeAgent = {
  name: 'CodeAgent',
  model: 'gemma4:26b',
  systemPrompt: 'Jesteś agentem do analizy kodu. Szukasz błędów i proponujesz minimalne poprawki.',
  tools: ['file_tree', 'read_file', 'search_files', 'git_diff', 'apply_patch'],
  memoryScope: 'code-agent',
  outputFormat: 'json'
};
```

### Tool

Tool to konkretna funkcja wykonawcza, np.:

```ts
read_file({ path: '/projekty/app/package.json' })
search_files({ root: '/projekty/app', query: 'JWT_SECRET' })
terminal_run_safe({ command: 'pnpm', args: ['test'], cwd: '/projekty/app' })
```

## 3. Docelowa architektura

```text
Telegram / UI / CLI
      |
      v
Meta Agent / Orchestrator
      |
      +-- planuje zadanie
      +-- wybiera tools
      +-- tworzy subtaski
      +-- deleguje do subagentów
      +-- zbiera wyniki
      +-- ocenia ryzyko
      +-- zwraca finalną odpowiedź
      |
      +------------------------------+
      |                              |
      v                              v
Local Tools                    Subagents
terminal, files, git,          CodeAgent, DevOpsAgent,
docker, mongo, n8n,            N8nAgent, DatabaseAgent,
ollama, logs                   CriticAgent
      |                              |
      +--------------+---------------+
                     |
                     v
            MongoDB / Memory / Task State
```

## 4. Kategorie narzędzi

Rekomendowany podział:

```text
1. System Tools
2. File and Code Tools
3. Git Tools
4. Terminal Tools
5. Process and Port Tools
6. Docker Tools
7. Ollama Tools
8. n8n Tools
9. MongoDB Tools
10. HTTP/API Tools
11. Memory and Task Tools
12. Approval and Safety Tools
```

## 5. Narzędzia systemowe

### 5.1 `system_info`

Cel: sprawdzenie podstawowych informacji o maszynie.

Przykładowe komendy pod spodem:

```bash
uname -a
lsb_release -a
free -h
df -h
lscpu
nvidia-smi
```

Kontrakt:

```ts
export interface SystemInfoOutput {
  os: string;
  kernel: string;
  cpu: string;
  ram: string;
  gpu?: string;
  disks: string[];
}
```

Zastosowanie:

```text
- diagnoza systemu
- sprawdzenie RAM/VRAM
- sprawdzenie dysków
- dobór lokalnego modelu LLM
- debugging wydajności
```

## 6. Narzędzia plików i kodu

### 6.1 `list_directory`

Cel: lista plików w katalogu.

Kontrakt:

```ts
export interface ListDirectoryInput {
  path: string;
  depth?: number;
  showHidden?: boolean;
}
```

Ograniczenia:

```text
Dozwolone ścieżki:
- /projekty
- /vm
- /home/linus

Domyślnie zablokowane:
- /etc
- /root
- /boot
- /proc
- /sys
- /dev
```

### 6.2 `file_tree`

Cel: pokazanie struktury projektu bez czytania wszystkich plików.

Kontrakt:

```ts
export interface FileTreeInput {
  root: string;
  depth: number;
  ignore?: string[];
}
```

Ignorować zawsze:

```text
node_modules
dist
build
.next
.git
coverage
.cache
venv
__pycache__
```

Zastosowanie:

```text
- szybkie zrozumienie struktury repo
- planowanie analizy
- zmniejszenie zużycia kontekstu LLM
```

### 6.3 `read_file`

Cel: bezpieczne czytanie plików.

Kontrakt:

```ts
export interface ReadFileInput {
  path: string;
  maxBytes?: number;
}

export interface ReadFileOutput {
  path: string;
  content: string;
  truncated: boolean;
  bytesRead: number;
}
```

Zalecenia:

```text
- domyślny limit: 200 KB
- większe pliki czytać fragmentami
- nie czytać sekretów bez specjalnego trybu i zgody
```

Blokowane wzorce:

```text
.env
.env.local
*.pem
*.key
id_rsa
id_ed25519
credentials.json
service-account*.json
*.p12
*.pfx
```

Dozwolone:

```text
.env.example
README.md
package.json
tsconfig.json
```

### 6.4 `search_files`

Cel: wyszukiwanie tekstu w projekcie.

Najlepiej użyć `ripgrep`:

```bash
rg "JWT_SECRET" /projekty/gastrobridge
```

Kontrakt:

```ts
export interface SearchFilesInput {
  root: string;
  query: string;
  fileGlob?: string;
  maxResults?: number;
  includeLineNumbers?: boolean;
}
```

Zastosowanie:

```text
- znajdź wszystkie process.env
- znajdź endpoint /login
- znajdź komponent SupplierDashboard
- znajdź TODO
- znajdź błędy w logach
- znajdź użycie konkretnej funkcji
```

### 6.5 `create_file`

Cel: tworzenie nowego pliku bez nadpisywania istniejącego.

Kontrakt:

```ts
export interface CreateFileInput {
  path: string;
  content: string;
}
```

Zasada:

```text
Jeśli plik istnieje, tool zwraca błąd i nie nadpisuje.
```

### 6.6 `write_file`

Cel: zapis pliku. Narzędzie potrzebne, ale ryzykowne.

Kontrakt:

```ts
export interface WriteFileInput {
  path: string;
  content: string;
  mode: 'create' | 'overwrite';
  createBackup?: boolean;
}
```

Zalecenia:

```text
- overwrite tylko w dozwolonych katalogach
- przed nadpisaniem robić backup
- preferować apply_patch zamiast write_file
```

Przykład backupu:

```text
filename.ts.bak-20260430-2230
```

### 6.7 `apply_patch`

Cel: bezpieczna edycja plików przez patch/diff.

To jest preferowany sposób zmiany kodu.

Kontrakt:

```ts
export interface ApplyPatchInput {
  repoPath: string;
  patch: string;
  dryRun?: boolean;
}

export interface ApplyPatchOutput {
  applied: boolean;
  dryRun: boolean;
  stdout: string;
  stderr: string;
}
```

Pod spodem:

```bash
git apply --check patch.diff
git apply patch.diff
```

Zalety:

```text
- można najpierw wykonać dry-run
- widać dokładnie co się zmienia
- łatwiej cofnąć zmianę
- mniejsze ryzyko nadpisania całego pliku
```

## 7. Narzędzia Git

### 7.1 `git_status`

Kontrakt:

```ts
export interface GitStatusInput {
  repoPath: string;
}
```

Pod spodem:

```bash
git status --short
git branch --show-current
```

Zastosowanie:

```text
- sprawdzenie bieżącej gałęzi
- sprawdzenie niezacommitowanych zmian
- ostrzeganie przed edycją cudzych zmian
```

### 7.2 `git_diff`

Kontrakt:

```ts
export interface GitDiffInput {
  repoPath: string;
  staged?: boolean;
}
```

Pod spodem:

```bash
git diff
git diff --staged
```

Po każdej zmianie agent powinien umieć zwrócić:

```text
- co zmienił
- dlaczego
- w których plikach
- czy zmiana jest bezpieczna
```

### 7.3 `git_log`

Kontrakt:

```ts
export interface GitLogInput {
  repoPath: string;
  limit?: number;
}
```

Pod spodem:

```bash
git log --oneline -n 20
```

### 7.4 `git_branch_info`

Opcjonalne narzędzie do sprawdzenia gałęzi.

```ts
export interface GitBranchInfoInput {
  repoPath: string;
}
```

Pod spodem:

```bash
git branch --show-current
git branch -vv
```

## 8. Narzędzia terminala

### 8.1 Problem z wolnym terminalem

Nie implementować tego jako podstawowego narzędzia:

```ts
execute_shell(command: string)
```

Lepszy wzór:

```ts
terminal_run_safe({
  command: 'pnpm',
  args: ['test'],
  cwd: '/projekty/gastrobridge/Agent-gastroBridge',
  timeoutMs: 120000,
  reason: 'Uruchomienie testów po zmianie kodu'
})
```

Używać `spawn`, nie `exec`.

Preferowane:

```ts
spawn(command, args, { cwd })
```

Unikać:

```ts
exec('pnpm test && rm -rf something')
```

### 8.2 `terminal_run_readonly`

Cel: uruchamianie tylko komend odczytowych.

Kontrakt:

```ts
export interface TerminalRunReadonlyInput {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  reason: string;
}
```

Dozwolone komendy:

```text
pwd
ls
cat
head
tail
rg
grep
find
which
whereis
ps
top
free
df
du
ss
lsof
git status
git diff
git log
docker ps
docker logs
systemctl status
journalctl
nvidia-smi
ollama list
ollama show
```

### 8.3 `terminal_run_safe`

Cel: uruchamianie bezpiecznych komend projektowych.

Kontrakt:

```ts
export interface TerminalRunSafeInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  reason: string;
}

export interface TerminalRunSafeOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}
```

Przykład:

```json
{
  "command": "pnpm",
  "args": ["test"],
  "cwd": "/projekty/gastrobridge/Agent-gastroBridge",
  "timeoutMs": 120000,
  "reason": "Uruchomienie testów po poprawce"
}
```

Zalecane ograniczenia:

```ts
const ALLOWED_CWD_PREFIXES = [
  '/projekty',
  '/vm',
  '/home/linus'
];

const BLOCKED_COMMANDS = [
  'sudo',
  'rm',
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'shutdown',
  'reboot',
  'chmod',
  'chown',
  'kill',
  'pkill'
];
```

### 8.4 `terminal_run_with_approval`

Cel: przygotowanie ryzykownej komendy do zatwierdzenia przez użytkownika.

Kontrakt:

```ts
export interface TerminalRunWithApprovalInput {
  command: string;
  args: string[];
  cwd: string;
  reason: string;
  riskLevel: 'medium' | 'high';
}
```

Wymagają potwierdzenia:

```text
sudo
apt install
apt remove
rm
mv
cp -r
chmod
chown
kill
pkill
systemctl restart
docker compose down
docker system prune
gcloud
firebase deploy
git reset
git clean
git push
mongosh update/delete
```

### 8.5 Komendy blokowane domyślnie

```text
rm -rf /
rm -rf ~
rm -rf /projekty
dd
mkfs
fdisk
parted
shutdown
reboot
curl ... | bash
wget ... | bash
chmod -R 777
chown -R
:(){ :|:& };:
```

## 9. Command profiles

Zamiast jednej allowlisty lepiej używać profili.

```ts
type CommandProfile =
  | 'read_only'
  | 'project_safe'
  | 'docker_safe'
  | 'database_readonly'
  | 'requires_approval'
  | 'blocked';
```

Przykład konfiguracji:

```ts
const COMMAND_POLICIES = [
  {
    command: 'git',
    allowedArgs: ['status', 'diff', 'log', 'branch'],
    profile: 'read_only'
  },
  {
    command: 'pnpm',
    allowedArgs: ['test', 'lint', 'build', 'typecheck'],
    profile: 'project_safe'
  },
  {
    command: 'docker',
    allowedArgs: ['ps', 'logs'],
    profile: 'read_only'
  },
  {
    command: 'docker',
    allowedArgs: ['compose', 'down'],
    profile: 'requires_approval'
  }
];
```

## 10. Narzędzia procesów, portów i logów

### 10.1 `process_list`

Kontrakt:

```ts
export interface ProcessListInput {
  filter?: string;
}
```

Pod spodem:

```bash
ps aux
```

Zastosowanie:

```text
- sprawdzenie n8n
- sprawdzenie MongoDB
- sprawdzenie Redis
- sprawdzenie Ollama
- sprawdzenie workerów
- sprawdzenie dev servera
```

### 10.2 `port_check`

Kontrakt:

```ts
export interface PortCheckInput {
  ports?: number[];
}
```

Pod spodem:

```bash
ss -ltnp
lsof -i :3000
lsof -i :5678
lsof -i :11434
```

Ważne porty w obecnym stacku:

```text
3000  - dashboard
5678  - n8n
11434 - Ollama
27017 - MongoDB
6379  - Redis
```

### 10.3 `service_status`

Kontrakt:

```ts
export interface ServiceStatusInput {
  serviceName: string;
}
```

Pod spodem:

```bash
systemctl status docker
systemctl status mongod
systemctl status redis-server
```

Restart usług powinien wymagać approval.

### 10.4 `log_tail`

Kontrakt:

```ts
export interface LogTailInput {
  path: string;
  lines?: number;
}
```

Pod spodem:

```bash
tail -n 200 /path/to/log.log
```

Ważne logi dla lokalnego AgentForge:

```text
/projekty/jarvis-dashboard-agent/.logs/worker.log
/projekty/jarvis-dashboard-agent/.logs/dashboard.log
```

## 11. Narzędzia Docker

### 11.1 `docker_ps`

Kontrakt:

```ts
export interface DockerPsOutput {
  containers: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    ports: string;
  }>;
}
```

Pod spodem:

```bash
docker ps --format '{{json .}}'
```

### 11.2 `docker_logs`

Kontrakt:

```ts
export interface DockerLogsInput {
  container: string;
  lines?: number;
}
```

Pod spodem:

```bash
docker logs --tail 200 container_name
```

### 11.3 `docker_compose_status`

Kontrakt:

```ts
export interface DockerComposeStatusInput {
  composePath: string;
}
```

Pod spodem:

```bash
docker compose ps
```

### 11.4 `docker_compose_up`

Kontrakt:

```ts
export interface DockerComposeUpInput {
  composePath: string;
  detached: boolean;
}
```

Można dopuścić bez zgody tylko dla znanych katalogów, np.:

```text
/projekty/agentforge
/projekty/jarvis-dashboard-agent
```

### 11.5 `docker_compose_down`

Wymaga potwierdzenia użytkownika.

Powód: może zatrzymać bazę, n8n, Redis albo inne usługi.

## 12. Narzędzia Ollama

### 12.1 `ollama_health_check`

Kontrakt:

```ts
export interface OllamaHealthCheckOutput {
  ok: boolean;
  url: string;
  error?: string;
}
```

Pod spodem:

```bash
curl http://localhost:11434/api/tags
```

### 12.2 `ollama_list_models`

Kontrakt:

```ts
export interface OllamaListModelsOutput {
  models: Array<{
    name: string;
    size?: string;
    modifiedAt?: string;
  }>;
}
```

Pod spodem:

```bash
ollama list
```

### 12.3 `ollama_model_info`

Kontrakt:

```ts
export interface OllamaModelInfoInput {
  model: string;
}
```

Pod spodem:

```bash
ollama show gemma4:26b
```

### 12.4 `ollama_generate`

Cel: bazowy mechanizm tworzenia subagentów opartych o lokalny model.

Kontrakt:

```ts
export interface OllamaGenerateInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  numCtx?: number;
  format?: 'json' | 'text';
}

export interface OllamaGenerateOutput {
  model: string;
  response: string;
  durationMs: number;
}
```

Przykład:

```json
{
  "model": "gemma4:26b",
  "systemPrompt": "Jesteś subagentem do analizy logów. Zwracasz tylko JSON.",
  "userPrompt": "Przeanalizuj te logi i znajdź najbardziej prawdopodobną przyczynę błędu.",
  "temperature": 0.2,
  "numCtx": 8192,
  "format": "json"
}
```

## 13. Narzędzia n8n

### 13.1 `n8n_health_check`

Kontrakt:

```ts
export interface N8nHealthCheckOutput {
  ok: boolean;
  url: string;
  error?: string;
}
```

Pod spodem:

```bash
curl http://localhost:5678
```

### 13.2 `n8n_list_workflows`

Wymaga aktywnego API n8n.

Kontrakt:

```ts
export interface N8nListWorkflowsOutput {
  workflows: Array<{
    id: string;
    name: string;
    active: boolean;
  }>;
}
```

Zastosowanie:

```text
- agent widzi istniejące workflow
- nie duplikuje automatyzacji
- może diagnozować obecną strukturę
```

### 13.3 `n8n_validate_workflow`

Cel: walidacja workflow przed utworzeniem lub aktywacją.

Kontrakt:

```ts
export interface N8nValidateWorkflowInput {
  workflowJson: object;
}

export interface N8nValidateWorkflowOutput {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
```

Sprawdzać:

```text
- czy node'y mają wymagane pola
- czy connections są poprawne
- czy nie brakuje credentiali
- czy webhook ma ścieżkę
- czy istnieją dead-end nodes
- czy workflow ma sensowny trigger
```

### 13.4 `n8n_create_workflow_draft`

Cel: tworzenie workflow jako draft, bez automatycznej aktywacji.

Kontrakt:

```ts
export interface N8nCreateWorkflowDraftInput {
  name: string;
  nodes: object[];
  connections: object;
  settings?: object;
}
```

Zasada:

```text
Agent może tworzyć draft.
Aktywacja wymaga potwierdzenia.
```

### 13.5 `n8n_activate_workflow`

Wymaga potwierdzenia użytkownika.

Powód: aktywacja workflow może uruchomić realne automatyzacje, wysyłać wiadomości, wykonywać requesty albo modyfikować dane.

## 14. Narzędzia MongoDB

### 14.1 `mongo_query_readonly`

Cel: bezpieczne czytanie danych z MongoDB.

Kontrakt:

```ts
export interface MongoQueryReadonlyInput {
  database: string;
  collection: string;
  filter: object;
  projection?: object;
  limit?: number;
}
```

Dozwolone:

```text
find
countDocuments
aggregate bez $out i $merge
```

Blokowane:

```text
insertOne
updateOne
updateMany
deleteOne
deleteMany
drop
createIndex bez zgody
$out
$merge
```

### 14.2 `mongo_schema_inspect`

Cel: poznanie struktury dokumentów bez czytania całej bazy.

Kontrakt:

```ts
export interface MongoSchemaInspectInput {
  database: string;
  collection: string;
  sampleSize?: number;
}
```

Zastosowanie:

```text
- rozpoznanie pól
- wykrycie typów danych
- pomoc w budowaniu query
- analiza struktury tasków i pamięci agentów
```

### 14.3 `mongo_write_with_approval`

Wymaga potwierdzenia użytkownika.

Kontrakt:

```ts
export interface MongoWriteWithApprovalInput {
  database: string;
  collection: string;
  operation: 'insertOne' | 'updateOne' | 'updateMany' | 'deleteOne';
  payload: object;
  reason: string;
}
```

## 15. Narzędzia HTTP/API

### 15.1 `http_request_local`

Cel: requesty do lokalnych usług.

Kontrakt:

```ts
export interface HttpRequestLocalInput {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: object;
  headers?: Record<string, string>;
  timeoutMs?: number;
}
```

Ograniczyć hosty:

```text
localhost
127.0.0.1
```

Typowe porty:

```text
3000  - dashboard
5678  - n8n
11434 - Ollama
```

### 15.2 `http_request_external`

Cel: kontrolowany dostęp do internetu.

Kontrakt:

```ts
export interface HttpRequestExternalInput {
  method: 'GET' | 'POST';
  url: string;
  body?: object;
  headers?: Record<string, string>;
  timeoutMs?: number;
}
```

Zabezpieczenia:

```text
- allowlista domen albo tryb approval
- limit response size
- brak wysyłania sekretów
- logowanie requestów
- blokada requestów do prywatnych zakresów IP
```

## 16. Narzędzia pamięci i tasków

### 16.1 `task_create`

Cel: utworzenie zadania w kolejce lub MongoDB.

Kontrakt:

```ts
export interface TaskCreateInput {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  assignedAgent?: string;
  parentTaskId?: string;
}
```

### 16.2 `task_update`

Kontrakt:

```ts
export interface TaskUpdateInput {
  taskId: string;
  status: 'queued' | 'running' | 'blocked' | 'done' | 'failed';
  note?: string;
  result?: object;
}
```

### 16.3 `task_list`

Kontrakt:

```ts
export interface TaskListInput {
  status?: 'queued' | 'running' | 'blocked' | 'done' | 'failed';
  assignedAgent?: string;
  limit?: number;
}
```

### 16.4 `memory_write`

Kontrakt:

```ts
export interface MemoryWriteInput {
  scope: string;
  key: string;
  value: object;
}
```

Przykład:

```json
{
  "scope": "agentforge",
  "key": "local_ports",
  "value": {
    "n8n": 5678,
    "ollama": 11434,
    "mongodb": 27017,
    "redis": 6379
  }
}
```

### 16.5 `memory_read`

Kontrakt:

```ts
export interface MemoryReadInput {
  scope: string;
  key?: string;
}
```

Agent powinien pamiętać:

```text
- gdzie są projekty
- jakie porty są używane
- jakie modele są dostępne
- jakie workflow istnieją
- jakie komendy start/stop działają
- jakie błędy były już naprawiane
```

## 17. Minimalny zestaw narzędzi na start

Nie zaczynać od 40 tools. Na start wystarczy 15.

```text
1. system_info
2. list_directory
3. file_tree
4. read_file
5. search_files
6. git_status
7. git_diff
8. apply_patch
9. terminal_run_readonly
10. terminal_run_safe
11. process_list
12. port_check
13. log_tail
14. ollama_generate
15. memory_read / memory_write
```

Ten zestaw pozwoli agentowi:

```text
- diagnozować projekt
- czytać kod
- szukać błędów
- odpalać testy
- patchować pliki
- sprawdzać logi
- sprawdzać porty
- korzystać z lokalnego LLM
- zapamiętywać ustalenia
```

## 18. Zestaw dla stacku Ubuntu + Ollama + n8n + MongoDB + Redis + Telegram

```text
Meta Agent
   |
   +-- System Tools
   |     +-- system_info
   |     +-- process_list
   |     +-- port_check
   |     +-- log_tail
   |
   +-- File/Code Tools
   |     +-- file_tree
   |     +-- read_file
   |     +-- search_files
   |     +-- apply_patch
   |
   +-- Git Tools
   |     +-- git_status
   |     +-- git_diff
   |     +-- git_log
   |
   +-- Runtime Tools
   |     +-- terminal_run_readonly
   |     +-- terminal_run_safe
   |     +-- run_tests
   |     +-- run_lint
   |     +-- run_build
   |
   +-- Ollama Tools
   |     +-- ollama_health_check
   |     +-- ollama_list_models
   |     +-- ollama_generate
   |
   +-- n8n Tools
   |     +-- n8n_health_check
   |     +-- n8n_validate_workflow
   |     +-- n8n_create_workflow_draft
   |
   +-- Database Tools
   |     +-- mongo_query_readonly
   |     +-- mongo_schema_inspect
   |
   +-- Memory/Task Tools
         +-- task_create
         +-- task_update
         +-- task_list
         +-- memory_read
         +-- memory_write
```

## 19. Podział narzędzi między subagentów

Nie każdy subagent powinien mieć wszystkie narzędzia.

### 19.1 Meta Agent

Rola:

```text
- planuje
- deleguje
- ocenia
- wybiera narzędzia
- decyduje, kiedy potrzebna jest zgoda użytkownika
```

Dostęp:

```text
task_create
task_update
task_list
memory_read
memory_write
ollama_generate
n8n_validate_workflow
terminal_run_readonly
```

### 19.2 Code Agent

Rola:

```text
- analiza kodu
- wyszukiwanie błędów
- proponowanie patchy
- uruchamianie testów
```

Dostęp:

```text
file_tree
read_file
search_files
git_status
git_diff
apply_patch
run_tests
run_lint
```

Brak dostępu do:

```text
sudo
docker compose down
mongo write
deploy
rm
chmod
chown
```

### 19.3 DevOps Agent

Rola:

```text
- diagnoza usług
- porty
- procesy
- Docker
- logi
```

Dostęp:

```text
system_info
process_list
port_check
docker_ps
docker_logs
service_status
log_tail
terminal_run_readonly
```

Akcje naprawcze tylko z approval.

### 19.4 n8n Agent

Rola:

```text
- projektowanie workflow
- walidacja workflow
- tworzenie draftów
- diagnoza n8n
```

Dostęp:

```text
n8n_health_check
n8n_validate_workflow
n8n_create_workflow_draft
read_file
create_file
write_file tylko w katalogu workflow templates
```

Aktywacja workflow wymaga approval.

### 19.5 Database Agent

Rola:

```text
- analiza schematów
- odczyt danych
- przygotowanie bezpiecznych query
```

Dostęp:

```text
mongo_query_readonly
mongo_schema_inspect
```

Zapisy tylko przez `mongo_write_with_approval`.

### 19.6 Critic Agent

Rola:

```text
- ocena planu
- ocena patcha
- wykrywanie ryzyka
- sprawdzenie, czy wynik odpowiada na zadanie
```

Dostęp:

```text
git_diff
read_file
memory_read
```

Nie powinien mieć dostępu do narzędzi wykonawczych.

## 20. Przykładowy workflow diagnostyczny

Zadanie użytkownika:

```text
Sprawdź, czemu n8n nie odpowiada.
```

Poprawny przebieg:

```text
1. port_check 5678
2. process_list filter n8n
3. docker_ps
4. docker_logs albo log_tail
5. analiza wyniku
6. jeśli problem jasny, przygotuj propozycję naprawy
7. jeśli potrzebny restart, poproś o zgodę
```

Niepoprawny przebieg:

```text
1. docker restart n8n bez sprawdzenia logów
2. systemctl restart docker bez zgody
3. docker compose down bez zgody
```

## 21. Przykładowy workflow naprawy kodu

Zadanie użytkownika:

```text
Znajdź, czemu logowanie nie działa po ostatnich zmianach.
```

Poprawny przebieg:

```text
1. git_status
2. git_diff
3. search_files query: login/auth/JWT_SECRET
4. read_file wybranych plików
5. terminal_run_safe pnpm test albo pnpm typecheck
6. analiza błędów
7. apply_patch dryRun
8. apply_patch właściwy
9. terminal_run_safe pnpm test
10. git_diff
11. raport końcowy
```

## 22. `run_project_command`

Bardzo przydatne narzędzie zamiast wolnego terminala.

Kontrakt:

```ts
export interface RunProjectCommandInput {
  project: 'agentforge' | 'gastrobridge' | 'n8n-local';
  command: 'test' | 'lint' | 'build' | 'dev' | 'start' | 'stop' | 'typecheck' | 'logs';
}
```

Przykładowe mapowanie:

```ts
const PROJECT_COMMANDS = {
  gastrobridge: {
    test: {
      command: 'pnpm',
      args: ['test'],
      cwd: '/projekty/gastrobridge/Agent-gastroBridge'
    },
    lint: {
      command: 'pnpm',
      args: ['lint'],
      cwd: '/projekty/gastrobridge/Agent-gastroBridge'
    },
    build: {
      command: 'pnpm',
      args: ['build'],
      cwd: '/projekty/gastrobridge/Agent-gastroBridge'
    },
    typecheck: {
      command: 'pnpm',
      args: ['typecheck'],
      cwd: '/projekty/gastrobridge/Agent-gastroBridge'
    }
  },
  agentforge: {
    start: {
      command: 'bash',
      args: ['/home/linus/Pulpit/agentforge-start.sh'],
      cwd: '/projekty/jarvis-dashboard-agent'
    },
    stop: {
      command: 'bash',
      args: ['/home/linus/Pulpit/agentforge-stop.sh'],
      cwd: '/projekty/jarvis-dashboard-agent'
    },
    logs: {
      command: 'tail',
      args: ['-n', '200', '/projekty/jarvis-dashboard-agent/.logs/worker.log'],
      cwd: '/projekty/jarvis-dashboard-agent'
    }
  }
};
```

Uwaga: `stop` powinien wymagać approval, jeśli zatrzymuje usługi używane przez inne procesy.

## 23. Polityka bezpieczeństwa dla ścieżek

### Dozwolone katalogi robocze

```text
/projekty
/vm
/home/linus
```

### Katalogi tylko do odczytu albo blokowane

```text
/etc
/root
/boot
/proc
/sys
/dev
/usr
/bin
/sbin
/lib
/lib64
```

### Katalogi ignorowane przy skanowaniu

```text
node_modules
.next
dist
build
coverage
.git
.cache
venv
__pycache__
```

## 24. Polityka sekretów

Agent nie powinien swobodnie czytać ani wypisywać sekretów.

Blokowane pliki:

```text
.env
.env.local
.env.production
*.pem
*.key
id_rsa
id_ed25519
credentials.json
service-account*.json
*.p12
*.pfx
```

Dozwolone pliki referencyjne:

```text
.env.example
.env.template
README.md
docs/*.md
```

Jeśli agent musi sprawdzić konfigurację, preferować narzędzie, które zwraca tylko nazwy zmiennych bez wartości:

```ts
export interface EnvKeysInspectInput {
  path: string;
}

export interface EnvKeysInspectOutput {
  keys: string[];
  missingRequiredKeys?: string[];
}
```

## 25. Polityka approval

Akcje wymagające potwierdzenia:

```text
- usuwanie plików
- nadpisywanie dużych plików
- restart usług
- zatrzymywanie kontenerów
- deploy
- git push
- git reset
- git clean
- operacje sudo
- instalacja paczek systemowych
- zapisy do MongoDB
- aktywacja workflow n8n
- wysyłanie wiadomości do użytkowników/klientów
- requesty do zewnętrznych API z danymi użytkownika
```

Format prośby o approval:

```json
{
  "action": "docker compose restart n8n",
  "riskLevel": "medium",
  "reason": "n8n nie odpowiada na porcie 5678, kontener działa, ale logi wskazują zawieszenie procesu",
  "expectedEffect": "Restart kontenera n8n",
  "rollback": "Jeśli restart nie pomoże, sprawdzić docker logs i konfigurację volume"
}
```

## 26. Logowanie działań agenta

Każde narzędzie powinno logować:

```text
- timestamp
- agent name
- tool name
- input bez sekretów
- output summary
- exit code
- duration
- risk level
- approval id, jeśli dotyczy
```

Przykładowy rekord:

```json
{
  "timestamp": "2026-04-30T22:30:00Z",
  "agent": "DevOpsAgent",
  "tool": "port_check",
  "input": { "ports": [5678, 11434] },
  "outputSummary": "Port 11434 open, port 5678 closed",
  "durationMs": 418,
  "riskLevel": "read_only"
}
```

## 27. Najczęstsze błędy przy budowie takiego systemu

```text
1. Danie agentowi pełnego terminala bez ograniczeń.
2. Brak allowlisty komend.
3. Brak limitów outputu z terminala.
4. Czytanie całych dużych plików do kontekstu LLM.
5. Brak blokady sekretów.
6. Brak approval dla ryzykownych akcji.
7. Zbyt wielu subagentów odpalanych równolegle na jednym GPU.
8. Brak trwałego stanu tasków.
9. Brak git_diff po zmianach.
10. Brak trybu dry-run dla patchy i workflow.
```

## 28. Finalna rekomendacja implementacyjna

Budować w trzech etapach.

### Etap 1: Agent diagnostyczny

Może:

```text
- czytać pliki
- szukać w kodzie
- sprawdzać logi
- sprawdzać porty
- sprawdzać procesy
- sprawdzać git diff
```

Nie może:

```text
- usuwać
- restartować
- instalować
- deployować
- edytować sekretów
- zapisywać do bazy
```

### Etap 2: Agent wykonawczy w projektach

Może:

```text
- tworzyć pliki
- patchować kod
- odpalać testy
- odpalać build
- tworzyć workflow n8n jako draft
```

Tylko w:

```text
/projekty
```

### Etap 3: Agent administracyjny

Może przygotować komendy typu:

```bash
docker compose restart n8n
sudo systemctl restart docker
apt install package-name
```

Ale wykonuje je dopiero po zatwierdzeniu użytkownika.

## 29. Najważniejszy rdzeń systemu

Jeśli trzeba wybrać tylko 10 narzędzi, wybrać te:

```text
1. search_files
2. read_file
3. file_tree
4. apply_patch
5. git_diff
6. terminal_run_safe
7. log_tail
8. port_check
9. ollama_generate
10. memory_read / memory_write
```

To jest fundament użytecznego lokalnego meta-agenta na Ubuntu.

## 30. Finalny schemat

```text
Meta Agent
   |
   +-- Diagnosis Tools
   |     +-- system_info
   |     +-- process_list
   |     +-- port_check
   |     +-- log_tail
   |
   +-- Code Tools
   |     +-- file_tree
   |     +-- read_file
   |     +-- search_files
   |     +-- apply_patch
   |     +-- git_diff
   |
   +-- Execution Tools
   |     +-- run_tests
   |     +-- run_lint
   |     +-- run_build
   |     +-- terminal_run_safe
   |
   +-- Agent Tools
   |     +-- ollama_generate
   |     +-- task_create
   |     +-- task_update
   |     +-- memory_read/write
   |
   +-- Integration Tools
         +-- n8n_validate_workflow
         +-- mongo_query_readonly
         +-- docker_logs
```

Najgorsze podejście:

```text
Daję agentowi pełny terminal i ufam, że będzie rozsądny.
```

Najlepsze podejście:

```text
Daję agentowi małe, dobrze opisane narzędzia.
Każde narzędzie robi jedną rzecz.
Ryzykowne akcje wymagają zgody.
Wszystko jest logowane.
Każda zmiana w plikach idzie przez patch/diff.
```
