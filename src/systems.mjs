// Star-system term sets — drives cross_domain entropy + lagrange affinity
// in the orbital classifier. Mirrors galaxy/system-terms.json.

export const SYSTEM_TERMS = {
  forge: new Set([
    'api','docker','deploy','network','infra','backend','devops',
    'container','nginx','ssl','firewall','ssh','ci/cd','build',
    'server','database','redis','cache','auth','test','lint',
    'kubernetes','tunnel','vpn','observability','monitoring',
  ]),
  signal: new Set([
    'seo','serp','keyword','content','email','outbound','lead',
    'marketing','campaign','analytics','conversion','funnel','utm',
    'audience','brand','editorial','publish','traffic','rank',
    'backlink','cohort','attribution','crm','sequence','growth',
    'linkedin','newsletter','social','youtube','podcast','profile',
    'persona','reputation',
  ]),
  mind: new Set([
    'llm','prompt','reasoning','agent','embedding','vector',
    'rag','chain-of-thought','evaluation','orchestration','memory',
    'knowledge','claude','openai','gpt','anthropic','inference',
    'fine-tune','judge','self-consistency','transcript','captions',
    'voice','synthesis','model','tokenization','training','dataset',
  ]),
}
