# seori (서리)

[omp](https://github.com/can1357/oh-my-pi)와 [herdr](https://github.com/herdrdev/herdr) 위에서 돌아가는, 여러 코딩 에이전트 세션을 함께 굴리는 도구입니다.

[English](README.md) | 한국어

seori의 설계는 [dori-superagent](https://github.com/sisyphuslabs/dori-superagent)를 바탕으로 합니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 보세요.

## seori가 하는 일

사람과 이야기하는 세션은 리드(lead) 하나뿐입니다. 일 하나하나는 레인(lane)이라는 별도 세션에서 돌아갑니다.

- 리드: 사람과 대화하는 유일한 omp 세션입니다. 요청을 받으면 브리프(작업 설명서)를 쓰고 레인을 엽니다. 레인이 보낸 결과를 확인하고 머지합니다.
- 레인: 일 하나당 하나씩 여는 omp 세션입니다. herdr 탭 하나를 혼자 씁니다. 브리프를 받아 omp 목표 모드(goal mode)로 일하고, 끝나면 증거 링크를 붙여 READY를 보냅니다.
- 듀티(duty): 레인들을 지켜보는 세션과 프로세스(`seori duty`)입니다. 바쁜 리드와 듀티 창에 온 메시지는 모아 뒀다가 한가해지면 전해 줍니다. 조용한 레인은 깨우고, 그래도 안 되면 리드에게 알립니다.
- 시간 단위 루프(hourly loop): `seori loop`입니다. 한 시간에 한 번 백로그(할 일 목록)를 보고, 레인 자리가 비어 있으면 다음 일을 시작합니다. 사람이 정해야 할 질문은 리드를 통해 묻습니다. 자세한 설계: [docs/hourly-loop.md](docs/hourly-loop.md)
- 데몬: `seori daemon`입니다. 메신저로 온 메시지를 받아 리드에게 전할 수 있게 저장하고, 에이전트가 걸어 둔 감시(watch)를 돌립니다. 자세한 내용은 [메신저 채널](#메신저-채널)과 [감시](#감시)에 있습니다.
- 리뷰와 머지 관문: PR은 정확히 지금 헤드(head) 커밋에 대한 CLEAR 리뷰 기록이 있고, 체크가 모두 통과해야만 머지됩니다.

herdr는 워크스페이스, 탭, 창(pane)을 만들어 주고, 각 omp 세션이 지금 쉬는 중(idle)인지, 일하는 중(working)인지, 막혀 있는지(blocked) 알려 줍니다. seori는 창에 무언가를 하기 전에 항상 이 상태부터 확인합니다.

## 준비물

- Bun 1.3 이상
- herdr 0.9.5 이상, 그리고 herdr의 omp 연동: `herdr integration install omp`. 이건 꼭 필요합니다. 연동이 없으면 herdr는 omp를 늘 "쉬는 중"으로 보고합니다. 그러면 seori가 바쁜 레인과 쉬는 레인을 구분할 수 없어서, 레인을 열지 않습니다. 설치 여부는 `herdr integration status`로 확인합니다. `omp:` 줄에 `not installed`가 없으면 됩니다.
- omp (oh-my-pi). `omp` 명령이 PATH에 있어야 합니다.
- GitHub CLI `gh`. PR 헤드 커밋, 체크, 리뷰, 머지에 씁니다.

## 빠르게 시작하기

```sh
bun install
bun link   # `seori` 명령을 PATH에 넣습니다. 싫으면 아래의 `seori`를 `bun src/cli.ts`로 바꿔 쓰면 됩니다.
```

herdr를 켜고, 셸에서:

```sh
seori up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 daemon=w1:p5 home=~/.seori
```

리드 창, 듀티 창, 듀티 루프, 시간 단위 루프, 데몬이 열립니다. 이제 리드 창에 말을 걸면 됩니다. 리드가 브리프를 쓰고 레인을 엽니다. 셸에서 직접 열어도 됩니다:

```sh
seori start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.seori/briefs/fix-flaky-login.md
seori status
```

브리프에는 목표, 입력, 결과물, 끝나는 조건, 제약을 씁니다. 예시는 [examples/brief.md](examples/brief.md)에 있습니다. 끝나는 조건은 누가 봐도 확인할 수 있게 씁니다(예: PR이 열려 있고 체크가 모두 통과함). 브리프에 "목표를 완료하라(complete the goal)" 같은 말은 쓰지 마세요. 목표 모드에서는 이 말 때문에 모델이 일을 일찍 끝내 버립니다.

레인 이름(key)은 `^[a-z][a-z0-9-]{1,40}$` 형식이어야 하고, 이미 열려 있는 이름은 쓸 수 없습니다.

레인 안에서 omp는 레인 규칙에 적힌 명령으로 진행 상황을 알리고 일을 마칩니다:

```sh
seori report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
seori report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
seori ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

리드는 `[READY fix-flaky-login]`을 받으면:

```sh
seori review owner/repo#12            # 새 omp 리뷰어가 헤드 커밋을 리뷰하고 기록(receipt)을 남깁니다
seori merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run) 또는 MERGE_REFUSED <이유>
seori merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
seori done fix-flaky-login            # 레인 창을 닫습니다. READY인 레인만 닫을 수 있습니다
```

## 명령 목록

```
seori up [--cwd DIR]                         리드, 듀티, 듀티 루프, 시간 단위 루프, 데몬 창을 엽니다
seori role <lead|duty> [PANE]                창을 리드나 듀티로 등록합니다 (기본: 지금 창)
seori start <key> --brief FILE [--cwd DIR]   레인을 엽니다: 새 탭, omp 세션, 브리프 + 레인 규칙
seori report <key> --text T [--status working|waiting]
seori ready <key> --text T --evidence LINK [--evidence LINK ...]
seori send <lead|duty|key|pane> --text T     지금 전하거나, 상대가 쉴 때까지 모아 둡니다
                [--to-shell]                운영자 전용: 에이전트가 없는 창에 이 메시지 하나만 입력합니다
seori inbox list <pane|role|key>             모아 둔 메시지 목록: 번호, 상태(queued|typed|held), 보낸 쪽, 시각, 앞 60자
seori inbox ack <pane|role|key> <index>      보류(held) 메시지를 지웁니다: 실제로 전해졌을 때
seori inbox resend <pane|role|key> <index>   보류 메시지를 풀어 줍니다: 다음에 다시 전합니다
seori duty [--once] [--interval SECONDS]     메시지 전달, 보고 없는 레인 깨우기, 리드에게 알리기, 사라진 레인 찾기
seori duty stop [--text WHY] | resume | status   비상 정지
seori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                            시간 단위: 백로그 정리, 놓친 일 점검, 다음 일 시작, 질문하기
seori loop stop [--text WHY] | resume | status   비상 정지와 마지막 실행 결과
seori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
seori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
seori backlog import <owner/repo> [--label seori] [--cwd DIR]   라벨 붙은 열린 이슈를 백로그로 가져옵니다
seori review <owner/repo#N> [--model M]      헤드 커밋을 새 omp 리뷰어로 리뷰 -> 기록
seori merge <owner/repo#N> [--dry-run]       헤드에 CLEAR 기록 + 체크 통과 -> squash 머지
seori done <key>                             리드가 READY 레인을 닫습니다
seori status
seori daemon                                 메신저에서 메시지를 받아 리드 채널에 저장하고 감시를 돌립니다 (seori up이 켭니다)
seori msg send (--reply-to ID[,ID...] | --to SOURCE:CHAT[:THREAD]) --text T [--again]
                                            메신저 메시지에 답합니다 (id 하나에 답 하나). --to는 알림을 보냅니다
seori msg close <id> --why T                 답할 필요가 없는 리드 채널 메시지(메신저 메시지나 감시 알림)를 닫습니다
seori msg list [--all]                       아직 열린 리드 채널 메시지: 메신저 메시지와 감시 알림 (--all: 전부, 상태 포함)
                                            칸: id  상태  지난 시간  종류  보낸 사람 또는 감시 이름  내용
seori watch add (--command CMD [--filter RE] [--cwd DIR] | --file PATH | --checks OWNER/REPO#N
                 | --pane PANE --status idle|working|blocked|gone)
                 [--name N] [--persistent] [--timeout DUR] [--for lead|KEY]
                                            무슨 일이 생기면 리드나 레인을 깨웁니다 (DUR: 90s, 30m, 2h)
seori watch list [--all]                     켜져 있거나 음소거된 감시 (--all: 전부)
seori watch stop <id|name>                   감시를 끝냅니다
seori watch rearm <id|name>                  깨우기 한도를 다 써서 음소거된 감시를 다시 켭니다
seori watch log <id|name> [-n N]             감시가 최근에 본 일
```

`--text`를 빼면 메시지를 표준 입력(stdin)에서 읽습니다. `send`, `report`, `ready`는 메시지가 전해졌는지 확실하지 않으면 `HELD <대상>`을 출력하고 종료 코드 3으로 끝납니다. 보류된 메시지는 다시 보내지 않습니다. 창을 직접 보고 `seori inbox ack`나 `seori inbox resend`로 처리하세요. `QUEUED`(종료 코드 0)는 상대 창의 받은 편지함에서 기다린다는 뜻입니다. `msg send`는 보냈으면 `SENT`(종료 코드 0), 메신저에 갔는지 확실하지 않으면 `HELD`(종료 코드 3), 거절하면 종료 코드 2로 끝납니다. 이미 답한 id에 또 답하려 하면 거절합니다. `HELD`일 때는 채팅을 직접 확인하고, 그래도 보내야 하면 `--again`을 붙입니다.

## 레인이 시작되는 방법

1. `seori start <key> --brief FILE`이 브리프와 레인 규칙을 합쳐 `~/.seori/briefs/<key>.md`에 씁니다.
2. 새 탭을 열고, 그 창에서 `herdr agent start`(`--kind omp`)로 omp를 켭니다. omp가 입력을 받을 준비가 되면 바로 돌아옵니다. 이때 프롬프트는 넘기지 않습니다. 넘기면 첫 작업이 끝날 때까지 기다리다가 시간 초과가 나기 때문입니다.
3. 이어서 `herdr agent prompt`로 `/goal` 명령을 보냅니다. 목표에는 브리프 위치와 레인 이름이 들어갑니다. omp는 목표 모드로 바뀌고, 목표를 이룰 때까지 계속 일합니다.
4. 레인은 `working`으로 기록되고, 리드는 `[START <key>]`를 받습니다.

레인 규칙은 omp에게 이렇게 시킵니다: 첫 답에서 결과물과 끝나는 조건을 다시 말할 것, 그리고 `seori ready`가 성공하기 전에는 목표를 완료 처리하지 말 것. 그 뒤 레인은 `[REPORT <key>]`(밖의 일 때문에 막혔으면 `[REPORT <key> WAITING]`)를 보내고, 마지막에 증거 링크와 함께 `[READY <key>]`를 보냅니다.

## seori가 지키게 하는 규칙

- 말하는 쪽은 하나: 사람과 이야기하는 건 리드뿐입니다. 레인은 사람에게 할 말을 모두 리드에게 보냅니다. 듀티는 머지하지 않고 사람과 이야기하지 않습니다.
- READY에는 증거가 필요: `seori ready`는 `--evidence` 링크가 하나도 없거나 최종 답이 비어 있으면 거절합니다. `seori done`은 READY가 아닌 레인을 닫지 않습니다.
- 리드와 듀티 창은 방해하지 않고, 레인은 일하는 중에도 메시지를 받음: `seori send`는 먼저 herdr에게 상대 상태를 묻습니다. 쉬는 중이면 바로 전합니다. 목표 모드의 레인은 목표가 끝날 때까지 계속 `working`으로 보이므로, 열려 있는 레인 창에는 일하는 중이어도 바로 전합니다. omp는 이를 작업 중 끼어든 지시(steer)로 받아 처리하고 하던 일을 이어 갑니다. 바쁜 리드나 듀티 창, 그리고 막혀 있는(blocked, 대화 상자가 열린) 창에 온 메시지는 `~/.seori/inbox/`에 모아 두고, 듀티 루프가 창이 받을 수 있을 때 한 번에 전합니다. 창 앞에 omp 대신 셸이 나와 있으면(omp가 꺼졌거나 Ctrl+Z로 멈춘 경우) 절대 입력하지 않습니다. 셸에 입력한 글자는 명령으로 실행되기 때문입니다.
- 10분, 20분, 40분 알림: 10분 동안 보고가 없는 레인에는 `prompts/nudge.md`를 보냅니다. 창이 일하는 중(working)이어도 보냅니다. 목표 모드의 레인은 목표가 끝날 때까지 계속 working으로 보이므로, working만으로는 진행으로 치지 않습니다. 알림은 작업 중 끼어든 지시(steer)로 들어갑니다. 20분에 한 번 더 보내고, 40분이 되면 리드에게 `[ESCALATE <key>]`를 보냅니다. 그래서 레인은 적어도 10분마다 진행 상황을 보고합니다. 새 보고가 들어오면 알림 횟수는 처음부터 다시 셉니다. 기다림(waiting)을 보고한 레인이나 막혀 있는(blocked) 레인은 건드리지 않습니다. READY 전에 창이 사라지면 `[LOST <key>]`로 알립니다.
- 머지 조건: `seori merge`는 PR의 지금 헤드 커밋에 대한 CLEAR 리뷰 기록(`~/.seori/receipts/`)을 요구합니다. 기록은 `seori review`만 남깁니다. 리뷰어는 새로 띄운 비대화형 omp이고, 저장소의 AGENTS.md, 스킬, 규칙, 확장을 읽지 않는 격리된 상태로 돕니다. `gh`로 PR을 읽고, 마지막 줄에 `VERDICT: CLEAR` 또는 `VERDICT: BLOCK`을 딱 한 번 씁니다. 이 줄이 없으면 기록도 없습니다. 그다음 `gh pr checks`에 체크가 하나 이상 있어야 하고, 모두 통과하거나 건너뛰어야 하며, 적어도 하나는 통과해야 합니다. 체크가 하나도 없으면 통과로 보지 않습니다. 리뷰 뒤에 푸시가 있으면 헤드가 바뀌므로 예전 기록은 쓸 수 없습니다.

## 메신저 채널

리드는 자기 창뿐 아니라 메신저로도 요청을 받을 수 있습니다. 메신저 설정은 `$SEORI_HOME/messengers.json`에 씁니다:

```json
{ "messengers": [ { "source": "fake", "owner": "u1" } ] }
```

`source`는 어떤 메신저인지, `owner`는 리드에게 말할 수 있는 단 한 명의 보낸 사람 id입니다. 다른 사람이 보낸 메시지는 버립니다. 안전 규칙은 이것뿐이고 dori와 같습니다. 주인만 리드에게 말할 수 있고, 주인의 메시지에는 따로 제한을 두지 않습니다. 지금은 `fake` 메신저만 있습니다. 텔레그램, 슬랙, 디스코드는 다음 단계에서 붙습니다. `fake`는 `$SEORI_HOME/messenger/fake/` 아래 파일로 움직입니다. `in.jsonl`에 `{"msgId":"1","chat":"c1","from":"u1","text":"..."}` 한 줄을 덧붙이면 리드에게 메시지를 보낸 것이 되고, 답은 `out.jsonl`에 쌓입니다. `send-mode`에 `ok`, `timeout`, `error`를 쓰면 보내기가 성공, 불확실, 실패로 끝납니다.

메시지가 가는 길:

1. 데몬(`seori up`의 다섯 번째 창)이 메시지를 받습니다. 주인이 보낸 것이면 먼저 `$SEORI_HOME/lead/`에 저장하고(디스크에 확실히 기록), 그다음에야 메신저에 받았다고 알립니다. 같은 메시지가 두 번 와도 한 번만 저장합니다. 데몬은 몇 초마다 살아 있다는 표시(heartbeat)를 남깁니다. 창에서 다시 켜기 루프로 돌기 때문에, 데몬이 죽어도 1초쯤 뒤에 다시 켜집니다. `messengers.json`이 바뀌면(새로 만들기, 고치기, 지우기) 데몬이 스스로 끝나고 루프가 새 설정으로 다시 켭니다. 그래서 `seori up` 뒤에 메신저를 설정해도 됩니다. 그 창에서 Ctrl-C를 누르거나 데몬 프로세스를 `kill`하면 데몬과 루프가 함께 멈춥니다. `$SEORI_HOME` 하나에 데몬은 하나만 돕니다(`messenger/daemon.lock`).
2. 리드의 omp는 `extensions/lead-channel.ts`를 불러옵니다. 리드만 불러오고, 듀티, 레인, 리뷰어는 불러오지 않습니다. 이 확장이 저장된 메시지를 id와 함께 리드의 대화에 넣고, 넣을 때마다 기록(ledger)을 남깁니다. omp를 다시 켜거나 `/new`, `/resume`, `/fork`를 해도 답하지 않은 메시지는 남아 있습니다.
3. 리드는 `seori msg send --reply-to <id> --text '...'`로 답하고, 답할 필요가 없으면 `seori msg close <id> --why '...'`로 닫습니다. 메신저가 받아 준 답이나 닫기만 id를 끝냅니다. 같은 id에 두 번 답하려 하면 거절합니다. 갔는지 확실하지 않은 답(보낸 뒤 시간 초과)은 기록해 두고, 사람이 채팅을 확인하고 `--again`을 붙이기 전까지 다시 보내지 않습니다.
4. 아직 답하지 않은 id는 다시 전합니다. 모두 합쳐 3번까지 전하고, 그래도 답이 없으면 포기합니다.

메신저가 설정되어 있으면 듀티 루프가 채널도 지켜봅니다. `messengers.json`을 읽을 수 없으면(데몬이 그 파일로는 켜지지 못합니다) 리드에게 한 번 알리고, 데몬의 heartbeat가 90초보다 오래되어도 리드에게 한 번 알립니다. 그리고 리드가 꺼져 있거나(메시지를 받아 가는 리드 omp가 없음) 2분 넘게 막혀 있으면(herdr가 blocked라고 보고함: 터미널에서 질문을 기다리거나, 모델 오류로 차례가 끝난 경우), 또는 3번 전하고도 포기한 메시지가 있으면, 메시지마다 한 번씩 채팅으로 사람에게 알립니다. 답이 이미 갔을 수도 있는 메시지(send-uncertain)나 포기한 메시지는 다시 전하지 않으므로, 꺼져 있다거나 막혀 있다는 알림도 보내지 않습니다.

## 감시

에이전트가 자기 창 밖의 일(CI, 개발 서버, 파일, 다른 창)을 기다릴 때는 계속 들여다보거나 잠들지 말고 감시를 걸어 두고 차례를 끝냅니다. 데몬이 대신 지켜보다가 무슨 일이 생기면 그 에이전트를 깨웁니다.

```sh
seori watch add --checks owner/repo#12 --name ci
# WATCH wmhk2x1a0b ci for fix-flaky-login until 2026-11-07T14:00:00.000Z
seori watch add --command 'bun run dev' --filter 'error|ready' --name dev
seori watch list
seori watch stop dev
```

종류:

- `--command CMD [--filter RE] [--cwd DIR]`: 오래 도는 셸 명령입니다. 출력 줄 가운데 정규식에 맞는 줄(`--filter`가 없으면 모든 줄)이 알림이 되고, 한꺼번에 나온 줄은 알림 하나로 묶입니다. 명령이 0으로 끝나면 감시도 끝납니다(done). 명령이 죽으면(0이 아닌 종료 코드나 시그널) 조금씩 기다렸다가 3번까지 다시 띄우고, 그래도 죽으면 감시를 멈춥니다.
- `--file PATH`: 파일이나 디렉터리입니다. 생기거나 바뀌거나 지워질 때마다 알림이 갑니다. 데몬이 꺼져 있던 사이에 바뀐 것도 알립니다.
- `--checks OWNER/REPO#N`: PR의 체크입니다. 모든 체크가 끝나면(통과든 실패든) 알림 하나를 보내고 끝납니다.
- `--pane PANE --status idle|working|blocked|gone`: herdr 창의 에이전트 상태입니다. 그 상태가 되면 알림 하나를 보내고 끝납니다.

주인: 레인 창에서 걸면(`SEORI_LANE`이 있으면) 그 레인을, 아니면 리드를 깨웁니다. `--for lead`나 `--for <레인 키>`로 다른 주인을 정할 수 있습니다. 감시는 어느 에이전트든 걸 수 있고, 확인을 묻지 않습니다. 알림은 모두 `[watch <이름> <id>]`로 시작하며 답할 필요가 없습니다. 리드는 리드 채널로 받습니다(차례 도중에도 전해짐). 종류는 `watch`, id는 `watch:<감시 id>:<번호>`이고, 리드가 보면 저절로 닫힙니다. `seori msg list --all`에 메신저 메시지와 함께 보이며, `seori msg send --reply-to`에 감시 id를 주면 거절합니다. 레인은 자기 창으로 받습니다(다른 레인 메시지처럼 차례 도중에도). 레인이 닫히면 그 레인의 감시도 멈춥니다.

한도:

- 감시는 2시간 동안 살아 있습니다. `--timeout`으로 1초에서 24시간까지 정할 수 있습니다.
- `--persistent`를 주면 7일 동안 살아 있습니다. 주인마다 5개까지이고, 6번째는 거절합니다.
- 깨우기 한도: 한 시간 안에 6번 깨우면 감시가 음소거됩니다. 그 뒤로는 알림을 보내지 않고 세기만 합니다. `seori watch rearm`으로 다시 켜면 한도가 처음으로 돌아가고, 그동안 놓친 알림 수를 알려 줍니다.
- 거절(24시간이 넘는 timeout, 6번째 persistent 감시, 잘못된 `--filter` 정규식, 이미 쓰는 이름)은 종료 코드 2입니다.

`seori watch list`는 감시마다 id, 이름, 주인, 상태, 무엇을 보는지, 지난 시간, 남은 시간, 지난 한 시간 동안 깨운 횟수, 음소거 중 놓친 알림 수를 보여 줍니다. `seori watch log <id|name>`는 감시가 본 일과 보낸 알림을 보여 줍니다.

omo의 `monitor`와 비교하면: 지켜보는 대상의 종류, 알림 묶기, 깨우기 한도, 7일짜리 감시 5개는 같습니다. 다른 점은 감시가 에이전트 세션이 아니라 seori 안에(`$SEORI_HOME/watches/`에 감시마다 파일 하나) 있다는 것입니다. 그래서 `/new`, omp 재시작, 데몬 재시작에도 살아남고(다시 켜진 데몬이 이어서 돌림), `seori watch list` 하나로 모두 볼 수 있고, 죽은 명령은 저절로 다시 띄우며, PR 체크와 herdr 창 상태를 따로 지켜볼 수 있습니다.

## 상태 저장 위치

모든 상태는 `~/.seori`(또는 `$SEORI_HOME`) 아래 JSON 파일입니다: `lanes/`, `inbox/`, `briefs/`, `receipts/`, 시간 단위 루프용 `backlog/`, `loop/`, 듀티 정지 파일용 `duty/`, 리드 채널용 `lead/`(저장된 메신저 메시지, 리드에게 온 감시 알림, 그 기록), 데몬의 잠금 파일과 heartbeat, `fake` 메신저용 `messenger/`, 감시와 그 기록용 `watches/`, 그리고 `messengers.json`. omp 세션 말고 계속 도는 프로세스는 듀티 루프, 시간 단위 루프, 데몬(그리고 명령 감시가 띄운 명령)뿐입니다. 실행에 필요한 건 Bun 하나입니다.

## 환경 변수

| 변수 | 뜻 |
|---|---|
| `SEORI_HOME` | 상태 폴더, 기본 `~/.seori` |
| `SEORI_AGENT_CMD` | 리뷰어용 omp 명령, 기본 `omp` (리드, 듀티, 레인은 항상 `herdr agent start --kind omp`로 시작) |
| `SEORI_MODEL` | seori가 띄우는 모든 omp의 모델(`--model`)이자 리뷰어 기본 모델. 비우면 omp 기본 모델 |
| `SEORI_CMD` | 에이전트와 루프 창이 seori를 부르는 방법, 기본 `SEORI_HOME=<home> [SEORI_HERDR_SESSION=…] [SEORI_MODEL=…] bun <경로>/src/cli.ts` |
| `SEORI_HERDR_SESSION` | 사용할 herdr 세션 이름 |
| `SEORI_MAX_LANES` | `seori loop --max-lanes` 기본값 (3) |
| `SEORI_MAX_STARTS` | `seori loop --max-starts` 기본값 (2) |
| `SEORI_MAX_LOAD` | `seori loop --max-load` 기본값 |
| `SEORI_LANE` | seori가 레인 창에 넣어 주는 값. `seori send`의 기본 보낸 쪽이자 `seori watch add`의 기본 주인 |

## 테스트

```sh
bun test         # 가짜 herdr와 gh로 도는 단위 테스트. 모델을 부르지 않습니다
bun run typecheck
```

끝단 테스트 `test/e2e.test.ts`(레인과 시간 단위 루프)와 `test/e2e-channel.test.ts`(메신저 채널: 한가할 때, 바쁠 때, 몰아서, 리드 재시작, `/new`, 하위 에이전트, Esc, 모델 장애와 복구, 계속된 장애로 포기, 데몬 강제 종료와 설정 변경)는 진짜 herdr(omp 연동 설치), PATH의 omp, 그리고 `SEORI_E2E_OMP=1`이 필요합니다. 진짜 모델을 부르므로 비용이 들고, 조건이 없으면 건너뜁니다. 채널 테스트 전체는 약 18분 걸립니다. `SEORI_E2E_ONLY=1,2,3`처럼 일부만 돌릴 수 있습니다(8번 장애 시나리오만 약 9분).

## 텔레메트리

없습니다. seori는 어디에도 데이터를 보내지 않습니다.

## 원본과 다른 점

- 에이전트: 원본과 달리 omp를 씁니다. 기본 에이전트 명령은 `omp`입니다.
- 레인은 `herdr agent start --kind omp`로 켜고 `/goal`로 시작하므로, 모든 레인이 omp 목표 모드로 돕니다. 브리프에는 확인 가능한 끝나는 조건을 씁니다.
- herdr의 omp 연동이 꼭 필요합니다. 이게 있어야 herdr가 omp의 상태를 알 수 있습니다.
- 리뷰어는 저장소의 AGENTS.md, 스킬, 규칙, 확장에서 격리된 비대화형 omp입니다.
- 텔레메트리가 없습니다.
- 이름: 명령 `seori`, 상태 폴더 `~/.seori`, 환경 변수 `SEORI_*`.
- 원본의 메신저용 스킬은 들어 있지 않습니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 보세요.
