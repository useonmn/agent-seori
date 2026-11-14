# Onboarding

Run once, after setup, with the owner. The aim is to learn enough about the owner, their work and their company that seori can act without asking about basics. Talk to the owner in their language. What you learn goes to two places: omp memory, which the lead and every lane recall from, and the owner profile `$SEORI_HOME/owner.md` (`~/.seori/owner.md` by default), which the lead reads at the start of every session and the owner can open and edit.

Before starting, recall memory (omp's `recall` tool) for an earlier onboarding and read `owner.md` if it exists. If onboarding was done, or declined, do not run it again unless the owner asks.

Run it in this session while the owner is at the keyboard. If they would rather do it from the messenger, hand it to the lead: `seori send lead --text 'Run onboarding with the owner over the messenger, following <path to this file>'`.

## 1. Ask for consent first

Before you read anything, ask (in the owner's language):

> To help you well I first need to learn how you work: which tools you use, what you're working on and why, and who you and your company are. That's what lets me do real work for you. May I go through your tools to learn this?

Wait for the answer. If it is no, retain that onboarding was declined and stop. Ask again only if the owner brings it up.

## 2. Find the owner's main tools

Look only at what is visible without opening anyone's data: installed CLIs and their login state (`gh auth status`, and the like), logged-in apps, config files that name a workspace, the messenger chosen in setup. Usual candidates:

- messengers: Slack, Discord, Telegram, KakaoTalk, LINE
- docs and knowledge: Notion, Google Docs, Confluence
- tickets: Linear, Jira, GitHub Issues
- code: GitHub, GitLab, the repositories on this machine
- mail and calendar: Gmail and Google Calendar, Outlook

## 3. Ask per tool, explaining each integration

For each tool, say which integration you would use, what it reads, and why. Ask for that tool alone. For example:

> The GitHub CLI (gh) reads your repos, issues and pull requests so I know what you're building. Allow?

> I'd read the Slack channels and threads the bot is in, so I learn who you work with and on what. Allow?

On Slack the bot sees only the DMs with it and the channels it was invited to; ask the owner to invite it where the real work happens if they want it to learn from there.

A no skips that tool. Retain every no, and do not ask about that tool again unless the owner raises it.

## 4. Crawl each allowed tool in depth, read-only

With the omp-ulw extension enabled (`omp plugin list` shows it), hand this crawl to a lane started with `--workflow ulw`, with a brief that names the tools the owner allowed, says read-only, and lists what to retain; keep the conversation with the owner in this session, and write `owner.md` yourself from what the lane reports.


Read; never post, react, edit, mark read, accept or send. Go deep enough to understand the work, not only the titles:

| Tool | Read |
|---|---|
| messengers | the busiest channels and threads of the last few weeks, pinned messages, who talks to whom about what |
| Notion, docs | top-level pages, databases and their recent rows, anything named roadmap, plan, OKR, strategy, onboarding |
| Linear, Jira | open projects, active cycles, issues assigned to or created by the owner |
| GitHub, local repos | repos the owner pushed to recently, open PRs and issues, READMEs, each repo's commit identity |
| mail, calendar | recurring meetings, the next two weeks, frequent correspondents (subjects, not full bodies, unless the owner allowed bodies) |

## 5. Write memory and the owner profile as you go

Memory is written with omp's memory tools: `retain` stores a fact, `recall` and `reflect` read it back. The lead and every lane recall from the same memory, so this is how seori remembers the owner. Store facts about the owner, their company and their tools with `scope: "global"`, since lanes run in other directories; facts about one repository may stay at the default project scope.

Retain each fact as soon as you learn it, instead of saving it all for the end. Each item is specific and self-contained (who, what, why, where to find it):

- **work:** active projects, what each is for, current goals and deadlines;
- **persona:** the owner's role, how they write, what they care about, what they dislike;
- **company:** what it does, products, customers in general terms, the people the owner works with most and their roles;
- **tools:** which tools are allowed, which were declined, and where things live (workspace names, repo paths, project keys).

Never store secrets in memory: no tokens, passwords, API keys, cookies, private URLs with credentials in them, or the contents of `secrets.json`. Keep other people's private messages out too. Record facts and where to find them, not copies of the data.

Facts about the owner also go into `owner.md`, a short markdown file of plain facts, one line each, in these sections (leave out a section you have nothing for):

```markdown
# Owner

## Who
## Addressing and writing
## Work and projects
## Tools and accounts
## Preferences and rules
```

Who: name, role, company and what it does. Addressing and writing: how they want to be addressed and written to. Work and projects: the active ones, what each is for, the people they work with most and their roles. Tools and accounts: which tools are allowed and which declined, and where things live (workspace names, repo paths, project keys), never a credential. Preferences and rules: standing ones the owner gave. When a new fact supersedes a line, replace the line instead of adding a second one. The same exclusions hold: no secrets, no copies of other people's messages. If `owner.md` is already there, the owner may have edited it: keep their lines and add yours.

If the owner offers a Git identity for a repo, suggest adding it to `repoIdentities` in `~/.seori/config.json` (see `setup.md`) and write it only with their go.

## 6. Report back

Send one short summary in the owner's language: what you now know (work, goals, persona, company), which tools you used, which ones you skipped because the owner declined, and the gaps you could not fill. Ask about the gaps only if they block real work. Make sure `owner.md` holds that summary, and tell the owner it is their profile: they can open `~/.seori/owner.md` (or `$SEORI_HOME/owner.md`) and correct or add to it, and what they write there wins over memory. Then retain that onboarding is done, with the date.
