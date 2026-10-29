/* =======================================================================
   i18n: English is the source text and the key; PT_BR maps it to
   Brazilian Portuguese. Missing translations fall back to English.

   Language order: ?lang= in the URL, then localStorage, then
   navigator.language (pt* -> pt-BR, anything else -> en).
   ======================================================================= */
export const LANGS = [['en', 'English'], ['pt-BR', 'Português (BR)']]
const STORE_KEY = 'kd:lang'

/** Normalizes any language tag to one we ship, or '' when unknown. */
export function normalizeLang(tag) {
  const s = String(tag || '').trim().toLowerCase()
  if (!s) return ''
  if (s.startsWith('pt')) return 'pt-BR'
  if (s.startsWith('en')) return 'en'
  return ''
}

function readStorage(storage) {
  try { return storage?.getItem(STORE_KEY) || '' } catch { return '' }
}

/** Pure detection, so tests can feed every source. */
export function detectLang({ search = '', storage, navigatorLanguage = '' } = {}) {
  let fromQuery = ''
  try { fromQuery = new URLSearchParams(search).get('lang') || '' } catch { /* bad query */ }
  return normalizeLang(fromQuery) || normalizeLang(readStorage(storage)) ||
    (normalizeLang(navigatorLanguage) === 'pt-BR' ? 'pt-BR' : 'en')
}

function browserEnv() {
  const env = {}
  try { env.search = typeof location !== 'undefined' ? location.search : '' } catch { /* no location */ }
  try { env.storage = typeof localStorage !== 'undefined' ? localStorage : undefined } catch { /* storage blocked */ }
  try { env.navigatorLanguage = typeof navigator !== 'undefined' ? navigator.language : '' } catch { /* no navigator */ }
  return env
}

let current = detectLang(browserEnv())

export function getLang() { return current }

/** Sets the language, remembers it, and optionally reloads the page. */
export function setLang(lang, reload = false) {
  current = normalizeLang(lang) || 'en'
  try { localStorage.setItem(STORE_KEY, current) } catch { /* storage blocked */ }
  if (reload && typeof location !== 'undefined') {
    const url = new URL(location.href)
    url.searchParams.delete('lang')
    location.replace(url.toString())
  }
}

/** Replaces {name} placeholders with vars.name. Unknown ones stay as they are. */
export function format(text, vars) {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])))
}

export function t(key, vars) {
  const text = current === 'pt-BR' && PT_BR[key] !== undefined ? PT_BR[key] : key
  return format(text, vars)
}

/* eslint-disable quote-props */
export const PT_BR = {
  "Overview": "Visão geral",
  "Nodes": "Nós",
  "Events": "Eventos",
  "Network": "Rede",
  "Config and Secrets": "Config e Secrets",
  "Storage": "Armazenamento",
  "Access and RBAC": "Acesso e RBAC",
  "AWS credentials": "Credenciais AWS",
  "Workloads": "Cargas",
  "Resources": "Recursos",
  "cluster (kubeconfig context)": "cluster (context do kubeconfig)",
  "loading clusters...": "carregando clusters...",
  "local, docker": "local, docker",
  "test cluster running in Docker on this machine ({server})": "cluster de teste rodando no Docker desta máquina ({server})",
  "LOCAL, NOT THE CLOUD": "LOCAL, NÃO É A NUVEM",
  "all namespaces": "todos os namespaces",
  "Safe by design: reads freely, the shell asks first, nothing deletes": "Seguro por projeto: lê à vontade, o shell pergunta antes, nada apaga",
  "safe by design": "seguro por projeto",
  "auto refresh": "atualização automática",
  "manual": "manual",
  "every 5s": "a cada 5s",
  "every 10s": "a cada 10s",
  "every 30s": "a cada 30s",
  "language": "idioma",
  "refresh": "atualizar",
  "Status": "Situação",
  "server {v}": "servidor {v}",
  "{a}/{b} pods ok": "{a}/{b} pods ok",
  "{n} with problems": "{n} com problema",
  "no connection": "sem conexão",
  "loading...": "carregando...",
  "discovering clusters...": "descobrindo clusters...",
  "click to select all": "clique para selecionar tudo",
  "copied": "copiado",
  "copy": "copiar",
  "commands behind this screen": "comandos que geraram esta tela",
  "copy all": "copiar todos",
  "clear": "limpar",
  "hide": "esconder",
  "show": "mostrar",
  "nothing queried yet": "nada consultado ainda",
  "SSO login · {profile}": "Login SSO · {profile}",
  "close": "fechar",
  "The AWS CLI opens the browser by itself. If it does not, use the link and the code below.": "O AWS CLI abre o navegador sozinho. Se não abrir, use o link e o código abaixo.",
  "verification code:": "código de verificação:",
  "starting...": "iniciando...",
  "Valid session": "Sessão válida",
  "Not authenticated": "Não autenticou",
  "account {account} · {arn}": "conta {account} · {arn}",
  "try again": "tente de novo",
  "region": "região",
  "profile": "perfil",
  "keys saved to profile \"{profile}\" (~/.aws/credentials, backup made)": "chaves gravadas no perfil \"{profile}\" (~/.aws/credentials, backup feito)",
  "keys": "chaves",
  "cluster in the kubeconfig as {context}": "cluster no kubeconfig como {context}",
  "profile {profile} linked to {n} context(s)": "perfil {profile} vinculado a {n} context(s)",
  "kubeconfig backup at {path}": "backup do kubeconfig em {path}",
  "Inject credentials and cluster": "Injetar credencial e cluster",
  "paste and it extracts": "cole e ele extrai",
  "hide secrets": "ocultar segredos",
  "show secrets": "ver segredos",
  "Paste here what AWS gave you, as it came: the export block, the [profile] section in .ini format, the aws eks update-kubeconfig command, or all of it together. The fields below fill themselves and stay editable.": "Cole aqui o que a AWS te deu, do jeito que veio: o bloco de export, o trecho de [perfil] no formato .ini, o comando aws eks update-kubeconfig, ou tudo junto. Os campos abaixo são preenchidos sozinhos e continuam editáveis.",
  "AWS profile (saves/updates this one)": "perfil AWS (grava/atualiza este)",
  "AWS_SESSION_TOKEN (temporary)": "AWS_SESSION_TOKEN (temporária)",
  "EKS cluster name (--name)": "nome do cluster EKS (--name)",
  "role to assume (--role-arn)": "role a assumir (--role-arn)",
  "context alias (optional)": "apelido do context (opcional)",
  "Give it a profile name, or the keys are ignored": "Dê um nome de perfil, senão as chaves são ignoradas",
  "The paste has an access key but no chosen profile - and a key needs a profile in ~/.aws/credentials to exist.": "A colagem tem chave de acesso, mas nenhum perfil escolhido - e chave precisa de um perfil em ~/.aws/credentials para existir.",
  "Suggestion from the role:": "Sugestão a partir da role:",
  "use {profile}": "usar {profile}",
  "saving keys...": "gravando chaves...",
  "registering cluster...": "registrando cluster...",
  "save keys and register cluster": "gravar chaves e registrar cluster",
  "save keys to the profile": "gravar chaves no perfil",
  "register cluster in the kubeconfig": "registrar cluster no kubeconfig",
  "paste something above": "cole algo acima",
  "missing profile+keys, or cluster+region": "falta perfil+chaves, ou cluster+região",
  "The keys go to ~/.aws/credentials with mode 600 and a backup of the previous file, and they never come back through the API once saved - so to change them, paste again. Registering the cluster runs aws eks update-kubeconfig, which writes only to your ~/.kube/config (with backup): nothing is changed inside the cluster.": "As chaves vão para ~/.aws/credentials com permissão 600 e backup do arquivo anterior, e nunca voltam pela API depois de gravadas - por isso, para trocar, você cola de novo. Registrar o cluster roda aws eks update-kubeconfig, que escreve só no seu ~/.kube/config (com backup): nada é alterado dentro do cluster.",
  "profile {profile} linked (applies to every context of the same cluster)": "perfil {profile} vinculado (vale para todos os contexts do mesmo cluster)",
  "link removed from {context}": "vínculo removido de {context}",
  "reading ~/.aws": "lendo ~/.aws",
  "valid": "válida",
  "AWS CLI not found": "AWS CLI não encontrado",
  "Install the AWS CLI v2 to test sessions, log in with SSO and register EKS clusters.": "Instale o AWS CLI v2 para testar sessões, fazer login SSO e registrar clusters EKS.",
  "One credential per cluster, no clash between environments": "Uma credencial por cluster, sem conflito entre ambientes",
  "Your kubeconfig calls aws eks get-token without saying which profile to use, so it takes whatever AWS_PROFILE is exported in the shell. That is why staging and production get in each other’s way. Link the profile here and Kube Deck injects the right credential in every call to that cluster, ignoring whatever is loose in the environment.": "Seu kubeconfig chama aws eks get-token sem dizer qual perfil usar, então ele pega o AWS_PROFILE que estiver exportado no shell. É por isso que homologação e produção se atrapalham. Vinculando o perfil aqui, o Kube Deck injeta a credencial certa em cada chamada daquele cluster e ignora o que estiver solto no ambiente.",
  "Done": "Feito",
  "It did not work": "Não deu",
  "Clusters and credentials": "Clusters e credencial",
  "{n} without a linked profile": "{n} sem perfil vinculado",
  "all linked": "todos vinculados",
  "cluster (context)": "cluster (context)",
  "aws account": "conta aws",
  "profile used": "perfil usado",
  "session": "sessão",
  "actions": "ações",
  "(uses the one from the shell)": "(usa o do shell)",
  "same aws account": "mesma conta aws",
  "all profiles": "todos os perfis",
  "not linked": "sem vínculo",
  "not tested": "não testada",
  "test": "testar",
  "SSO login": "login SSO",
  "link {profile}": "vincular {profile}",
  "Profiles in ~/.aws": "Perfis em ~/.aws",
  "type": "tipo",
  "account": "conta",
  "change keys": "trocar chaves",
  "all containers": "todos os containers",
  "last {n}": "últimas {n}",
  "following": "seguindo",
  "paused": "parado",
  "log of the previous container incarnation (--previous)": "log da encarnação anterior do container (--previous)",
  "previous": "anterior",
  "search the log...": "buscar no log...",
  "{n} lines": "{n} linhas",
  "live": "ao vivo",
  "disconnected": "desconectado",
  "the command running right now": "o comando que está rodando agora",
  "no output so far...": "sem saída até agora...",
  "connecting...": "conectando...",
  "error": "erro",
  "Summary": "Resumo",
  "Containers": "Containers",
  "Logs": "Logs",
  "Terminal": "Terminal",
  "close (esc)": "fechar (esc)",
  "node": "nó",
  "pod ip": "ip do pod",
  "phase": "fase",
  "created": "criado",
  "controlled by": "controlado por",
  "Equivalent commands": "Comandos equivalentes",
  "image": "imagem",
  "ports": "portas",
  "none": "nenhuma",
  "{n} variables": "{n} variáveis",
  "died before": "morreu antes",
  "no events for this pod": "sem eventos para este pod",
  "when": "quando",
  "reason": "motivo",
  "message": "mensagem",
  "Open a shell?": "Abrir um shell?",
  "Open a shell in {ns}/{pod} on {context}? This runs a process inside the cluster.": "Abrir um shell em {ns}/{pod} no {context}? Isso roda um processo dentro do cluster.",
  "the current context": "context atual",
  "Cancel": "Cancelar",
  "Open shell": "Abrir shell",
  "connection refused": "conexão recusada",
  "the browser denied clipboard access; use ctrl+shift+v": "o navegador negou o acesso à área de transferência; use ctrl+shift+v",
  "container": "container",
  "(the first one)": "(o primeiro)",
  "right click: copies if there is a selection, otherwise pastes": "botão direito: copia se houver seleção, senão cola",
  "reconnect": "reconectar",
  "Shell not opened": "Shell não aberto",
  "Nothing ran inside the cluster. Use \"Open shell\" when you want one.": "Nada rodou dentro do cluster. Use \"Abrir shell\" quando quiser um.",
  "Did not open": "Não abriu",
  "session ended - \"reconnect\" opens another one.": "sessão encerrada - \"reconectar\" abre outra.",
  "connected": "conectado",
  "ended": "encerrado",
  "refreshing": "atualizando",
  "This is a local test cluster, not your cloud": "Este é um cluster local de teste, não a sua nuvem",
  "It runs in Docker containers on this machine. To see a real environment, switch the cluster in the selector at the top.": "Ele roda em contêineres Docker nesta máquina. Para ver um ambiente de verdade, troque o cluster no seletor do topo.",
  "all ready": "todos prontos",
  "Live pods": "Pods vivos",
  "{n} healthy": "{n} saudáveis",
  "Broken now": "Quebrado agora",
  "using resources": "consumindo recursos",
  "nothing broken": "nada quebrado",
  "Leftovers of dead pods": "Restos de pods mortos",
  "reserve no resources": "não reservam recursos",
  "cluster total": "soma do cluster",
  "{n} pods are leftovers, not active problems": "{n} pods são restos, não problemas ativos",
  "They are in the Failed phase: the containers already died and were removed from the node. They reserve no CPU or memory, do not count for the scheduler, take no pod slot on the node and do not count in ResourceQuota. What is left is just the object in etcd, the events and the noise on your screen. Cleaning them up is hygiene, not incident response.": "Eles estão em fase Failed: os containers já morreram e foram removidos do nó. Não reservam CPU nem memória, não entram na conta do scheduler, não ocupam vaga de pod no nó e não contam em ResourceQuota. O que sobrou é só o objeto no etcd, os eventos e a poluição na sua tela. Limpar é higiene, não é resolver incidente.",
  "All on the same node ({node}), which points to eviction under resource pressure or a kubelet restart on that node.": "Todos no mesmo nó ({node}), o que aponta para despejo por pressão de recursos ou reinício do kubelet naquele nó.",
  "Broken now (using resources)": "Quebrado agora (consumindo recursos)",
  "state": "estado",
  "age": "idade",
  "{n} · zero resources reserved": "{n} · zero recurso reservado",
  "per node:": "por nó:",
  "(Kube Deck never deletes anything)": "(o Kube Deck não apaga nada)",
  "how it died": "como morreu",
  "resources": "recursos",
  "none reserved": "nenhum reservado",
  "dead for": "morto há",
  "{n} with workloads": "{n} com carga",
  "broken now": "quebrado agora",
  "dead leftovers": "restos mortos",
  "memory": "memória",
  "cpu use": "uso cpu",
  "mem use": "uso mem",
  "Warning events": "Eventos de aviso",
  "no recent warnings": "nenhum aviso recente",
  "object": "objeto",
  "{a} of {b}": "{a} de {b}",
  "only broken now": "só quebrado agora",
  "hides pods in the Failed phase, which reserve no resources": "esconde pods em fase Failed, que não reservam recursos",
  "hide {n} leftovers": "esconder {n} restos",
  "filter pods...": "filtrar pods...",
  "dead pod, reserves no resources": "pod morto, não reserva recursos",
  "Failed phase: containers already died, reserves no CPU or memory": "fase Failed: os containers já morreram, não reserva CPU nem memória",
  "dead pod": "pod morto",
  "zero": "zero",
  "name": "nome",
  "filter workloads...": "filtrar workloads...",
  "Pods on {node}": "Pods em {node}",
  "filter network...": "filtrar rede...",
  "no TLS": "sem TLS",
  "load balancer": "balanceador",
  "external": "externo",
  "empty": "vazio",
  "Secret values never leave the cluster": "Valores de Secret nunca saem do cluster",
  "This screen shows only the key names. The backend never exposes the content of any Secret.": "Esta tela mostra apenas os nomes das chaves. O backend não expõe o conteúdo de nenhum Secret.",
  "filter config...": "filtrar config...",
  "keys (names only)": "chaves (só nomes)",
  "size": "tamanho",
  "class": "classe",
  "only warnings": "só avisos",
  "filter events...": "filtrar eventos...",
  "Who you are on this cluster": "Quem você é neste cluster",
  "user": "usuário",
  "groups": "grupos",
  "all": "todos",
  "scope asked": "escopo perguntado",
  "What your RBAC allows, screen by screen": "O que seu RBAC permite, tela por tela",
  "allowed?": "pode?",
  "yes": "sim",
  "no": "não",
  "resource": "recurso",
  "verb": "verbo",
  "what it feeds in Kube Deck": "o que isso alimenta no Kube Deck",
  "Asked with": "Perguntado com",
  "A \"no\" here explains exactly why the matching screen shows up empty or partial - it is the cluster refusing, not the tool failing.": "Um \"não\" aqui explica exatamente por que a tela correspondente aparece vazia ou parcial - é o cluster recusando, não a ferramenta falhando.",
  "Even if your RBAC allows deleting or editing, Kube Deck has no route that changes the cluster. The only thing that runs inside it is the pod shell, and it asks for confirmation every time.": "Mesmo que seu RBAC permita apagar ou editar, o Kube Deck não tem nenhuma rota que altere o cluster. A única coisa que roda dentro dele é o shell do pod, e ele pede confirmação toda vez.",
  "querying the cluster": "consultando o cluster",
  "Authenticated, but without permission": "Autenticado, mas sem permissão",
  "Could not read the cluster": "Não consegui ler o cluster",
  "fix credentials now": "resolver credencial agora",
  "see what my user can do": "ver o que meu usuário pode fazer",
  "Partial view: your RBAC blocks {n} resource(s)": "Visão parcial: seu RBAC bloqueia {n} recurso(s)",
  "You are authenticated; the cluster just does not let your user read these resources. The rest of the screen is real. \"Access and RBAC\" shows exactly what you can do.": "Você está autenticado; o cluster é que não libera a leitura desses recursos para o seu usuário. O resto da tela é real. Em \"Acesso e RBAC\" dá para ver exatamente o que você pode.",
  "see my RBAC": "ver meu RBAC",
  "nothing here": "nada por aqui",
  "filter...": "filtrar...",
}
