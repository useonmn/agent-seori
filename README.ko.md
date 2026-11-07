# seori (서리)

[omp](https://github.com/can1357/oh-my-pi)와 [herdr](https://github.com/herdrdev/herdr) 위에서 돌아가는, 여러 코딩 에이전트 세션을 함께 굴리는 도구입니다.

[English](README.md) | 한국어

seori의 설계는 [dori-superagent](https://github.com/sisyphuslabs/dori-superagent)를 바탕으로 합니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 보세요.

## 서리 모드로 빠르게 시작하기

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh | bash
```

그다음 herdr를 켜고, 창 하나에서 omp를 실행해 `서리 모드`(또는 `seori mode`)라고 말하면 됩니다. 나머지는 seori-mode 스킬이 차례로 안내합니다. 사람이 고르거나 직접 해야 하는 단계에서는 멈추고 묻습니다. 순서는 이렇습니다: 봇 이름 정하기, herdr의 omp 연동, 설치, 메신저 고르기(텔레그램, 슬랙, 디스코드), 브라우저에서 함께 봇 만들기, `secrets.json`과 `seori msg check`, `seori msg pair`로 나를 주인으로 등록하기, 봇으로 첫인사 보내기, `seori up`, 그리고 온보딩. 온보딩에서는 내가 허락한 도구만 읽기 전용으로 살펴보고 omp 메모리에 기억해 둡니다. 설정이 끝난 뒤에 다시 `서리 모드`라고 하면 `seori boot`를 돌리고 그 결과를 알려 줍니다. 자세한 내용은 [서리 모드 스킬](#서리-모드-스킬)에 있습니다.

## seori가 하는 일

사람과 이야기하는 세션은 리드(lead) 하나뿐입니다. 일 하나하나는 레인(lane)이라는 별도 세션에서 돌아갑니다.

- 리드: 사람과 대화하는 유일한 omp 세션입니다. 요청을 받으면 브리프(작업 설명서)를 쓰고 레인을 엽니다. 레인이 보낸 결과를 확인하고 머지합니다.
- 레인: 일 하나당 하나씩 여는 omp 세션입니다. herdr 탭 하나를 혼자 씁니다. 브리프를 받아 omp 목표 모드(goal mode)로 일하고, 끝나면 증거 링크를 붙여 READY를 보냅니다. 완료 조건(Done 줄)을 달고 시작한 레인은, READY 몇 분 뒤 그 조건을 실제로 다시 확인해서 모두 맞으면 seori가 직접 닫습니다(리드가 반대하지 않으면).
- 듀티(duty): 레인들을 지켜보는 세션과 프로세스(`seori duty`)입니다. 바쁜 리드와 듀티 창에 온 메시지는 모아 뒀다가 한가해지면 전해 줍니다. 조용한 레인은 깨우고, 그래도 안 되면 리드에게 알립니다. Done 줄이 맞는 레인을 닫고, 한도를 넘거나 멈춰 버린 레인, 컴퓨터 자원 부족을 리드에게 알리고, 레인의 진행 상황을 주인의 메신저 스레드에 올립니다.
- 시간 단위 루프(hourly loop): `seori loop`입니다. 한 시간에 한 번 백로그(할 일 목록)를 보고, 레인 자리가 비어 있으면 다음 일을 시작합니다. 사람이 정해야 할 질문은 리드를 통해 묻습니다. 자세한 설계: [docs/hourly-loop.md](docs/hourly-loop.md)
- 데몬: `seori daemon`입니다. 메신저로 온 메시지를 받아 리드에게 전할 수 있게 저장하고, 에이전트가 걸어 둔 감시(watch)를 돌립니다. 자세한 내용은 [메신저 채널](#메신저-채널)과 [감시](#감시)에 있습니다.
- 리뷰와 머지 관문: PR은 정확히 지금 헤드(head) 커밋에 대한 CLEAR 리뷰 기록이 있고, 체크가 모두 통과하고, verify-pr도 통과해야만 머지됩니다.

herdr는 워크스페이스, 탭, 창(pane)을 만들어 주고, 각 omp 세션이 지금 쉬는 중(idle)인지, 일하는 중(working)인지, 막혀 있는지(blocked) 알려 줍니다. seori는 창에 무언가를 하기 전에 항상 이 상태부터 확인합니다.

## 준비물

- Bun 1.3 이상
- herdr 0.9.5 이상, 그리고 herdr의 omp 연동: `herdr integration install omp`. 이건 꼭 필요합니다. 연동이 없으면 herdr는 omp를 늘 "쉬는 중"으로 보고합니다. 그러면 seori가 바쁜 레인과 쉬는 레인을 구분할 수 없어서, 레인을 열지 않습니다. 설치 여부는 `herdr integration status`로 확인합니다. `omp:` 줄에 `not installed`가 없으면 됩니다.
- omp (oh-my-pi). `omp` 명령이 PATH에 있어야 합니다.
- GitHub CLI `gh`. PR 헤드 커밋, 체크, 리뷰, 머지에 씁니다.

## 직접 빠르게 시작하기

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
seori merge owner/repo#12             # 기록, 체크, verify-pr을 확인한 뒤 gh pr merge --squash --match-head-commit <sha>
seori done fix-flaky-login            # 레인 창을 닫습니다. READY인 레인만 닫을 수 있습니다
```

`--done`을 달고 연 레인은 저절로 닫힙니다. [완료 조건(Done 줄)과 자동 닫기](#완료-조건done-줄과-자동-닫기)를 보세요.

## 명령 목록

```
seori up [--cwd DIR]                         리드, 듀티, 듀티 루프, 시간 단위 루프, 데몬 창을 엽니다
seori role <lead|duty> [PANE]                창을 리드나 듀티로 등록합니다 (기본: 지금 창)
seori start <key> --brief FILE [--cwd DIR]   레인을 엽니다: 새 탭, omp 세션, 교훈 + 브리프 + 레인 규칙
            [--done "SIGNALS"] [--thread ID] [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--force]
                                            닫기 전에 Done 줄을 실제로 확인; ID = 진행 상황을 올릴 리드 채널 id;
                                            한도에 닿으면 리드에게 알림; 컴퓨터에 자리가 없으면 HOLD와 함께 종료 코드 4
seori report <key> --text T [--status working|waiting]
seori ready <key> --text T --evidence LINK [--evidence LINK ...]
seori send <lead|duty|key|pane> --text T     지금 전하거나, 상대가 쉴 때까지 모아 둡니다
                [--to-shell]                운영자 전용: 에이전트가 없는 창에 이 메시지 하나만 입력합니다
seori inbox list <pane|role|key>             모아 둔 메시지 목록: 번호, 상태(queued|typed|held), 보낸 쪽, 시각, 앞 60자
seori inbox ack <pane|role|key> <index>      보류(held) 메시지를 지웁니다: 실제로 전해졌을 때
seori inbox resend <pane|role|key> <index>   보류 메시지를 풀어 줍니다: 다음에 다시 전합니다
seori duty [--once] [--interval SECONDS]     메시지 전달, 보고 없는 레인 깨우기, 리드에게 알리기, 사라진 레인 찾기, Done 레인 닫기,
                                            한도와 멈춤 알림, 컴퓨터 자원 감시, 주인 스레드에 진행 상황 올리기
seori duty stop [--text WHY] | resume | status   비상 정지
seori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                            시간 단위: 백로그 정리, 놓친 일 점검, 다음 일 시작, 질문하기
seori loop stop [--text WHY] | resume | status   비상 정지와 마지막 실행 결과
seori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
seori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
seori backlog import <owner/repo> [--label seori] [--cwd DIR]   라벨 붙은 열린 이슈를 백로그로 가져옵니다
seori review <owner/repo#N> [--model M]      헤드 커밋을 새 omp 리뷰어로 리뷰 -> 기록
seori merge <owner/repo#N> [--dry-run]       헤드에 CLEAR 기록 + 체크 통과 + verify-pr -> squash 머지
seori verify-pr <owner/repo#N>               커밋 신원(config의 repoIdentities) + 수정에는 테스트 규칙; FAIL이면 종료 코드 2
seori done <key> [--lesson T [--evidence P]] 리드가 READY 레인을 닫습니다 (Done 줄은 실제로 맞아야 함); 교훈을 남길 수 있음
seori object <key> --reason T [--reason T]   리드가 READY 주장에 반대합니다: 이유와 함께 다시 일하는 상태로
seori pause <key> [--note T] | resume <key> [--note T]   레인의 omp 목표를 멈추거나 다시 켭니다 (확인 못 하면 종료 코드 3)
seori checkpoint <key> --step ID --result T --evidence P [--remote-effect R ...] | checkpoints <key>
seori lesson add <key|--cwd DIR> --rule T --evidence P | lesson list [--cwd DIR] | lesson mark <id> --outcome O
                                            O = helped|no-effect|harmful|encoded; 새 레인은 그 저장소의 pending/helped 교훈을 받음
seori worklog add <title> --source REF | next <id> <text> | note <id> <text> | close <id> --result T | list [--open]
seori boot                                   재시작이나 압축 뒤의 읽기 전용 점검 (읽지 못한 게 있으면 종료 코드 1)
seori can-launch | guard                     레인을 열 자리가 있나? (없으면 종료 코드 4, HOLD) | 컴퓨터 상태와 감시 상태
seori heavy <label> -- <cmd...>              부하가 낮고 무거운 작업 자리가 비면 무거운 명령을 돌립니다
seori status
seori daemon                                 메신저에서 메시지를 받아 리드 채널에 저장하고 감시를 돌립니다 (seori up이 켭니다)
seori msg send (--reply-to ID[,ID...] | --to SOURCE:CHAT[:THREAD]) --text T [--again]
                                            메신저 메시지에 답합니다 (id 하나에 답 하나). --to는 알림을 보냅니다
seori msg close <id> --why T                 답할 필요가 없는 리드 채널 메시지(메신저 메시지나 감시 알림)를 닫습니다
seori msg list [--all]                       아직 열린 리드 채널 메시지: 메신저 메시지와 감시 알림 (--all: 전부, 상태 포함)
                                            칸: id  상태  지난 시간  종류  보낸 사람 또는 감시 이름  내용
seori msg check [SOURCE]                     메신저 토큰이 맞는지 확인합니다(봇 이름을 출력). SOURCE를 주면 주인 등록 전에도 됩니다
seori msg pair <SOURCE> [--minutes N] [--write] [--all] [--force]
                                            설정용: 봇에게 다음에 DM을 보낸 사람을 출력. --write는 그 사람을 주인으로 기록;
                                            --force는 이미 등록된 텔레그램 주인을 다시 등록 (데몬 몫으로 쌓인 메시지는 버려짐)
seori watch add (--command CMD [--filter RE] [--cwd DIR] | --file PATH | --checks OWNER/REPO#N
                 | --pane PANE --status idle|working|blocked|gone)
                 [--name N] [--persistent] [--timeout DUR] [--for lead|KEY]
                                            무슨 일이 생기면 리드나 레인을 깨웁니다 (DUR: 90s, 30m, 2h)
seori watch list [--all]                     켜져 있거나 음소거된 감시 (--all: 전부)
seori watch stop <id|name>                   감시를 끝냅니다
seori watch rearm <id|name>                  깨우기 한도를 다 써서 음소거된 감시를 다시 켭니다
seori watch log <id|name> [-n N]             감시가 최근에 본 일
```

`--text`를 빼면 메시지를 표준 입력(stdin)에서 읽습니다. `send`, `report`, `ready`는 메시지가 전해졌는지 확실하지 않으면 `HELD <대상>`을 출력하고 종료 코드 3으로 끝납니다. 보류된 메시지는 다시 보내지 않습니다. 창을 직접 보고 `seori inbox ack`나 `seori inbox resend`로 처리하세요. `QUEUED`(종료 코드 0)는 상대 창의 받은 편지함에서 기다린다는 뜻입니다. `object`는 `OBJECTED <key>`를 출력하고, 레인에 보내는 메시지도 같은 방식으로 알려 줍니다. `msg send`는 보냈으면 `SENT`(종료 코드 0), 메신저에 갔는지 확실하지 않으면 `HELD`(종료 코드 3), 거절하면 종료 코드 2로 끝납니다. 이미 답한 id에 또 답하려 하면 거절합니다. `HELD`일 때는 채팅을 직접 확인하고, 그래도 보내야 하면 `--again`을 붙입니다. 알림(`msg send --to`)도 갔을 수 있으면 똑같이 `HELD`(종료 코드 3)입니다. 다만 알림은 따로 기록(ledger)이 없어서, 다시 보내면 한 통이 더 갑니다. `--again`은 답장에만 씁니다. `start`와 `can-launch`는 컴퓨터에 레인을 열 자리가 없으면 `HOLD <이유>`와 함께 종료 코드 4로 끝납니다. `pause`와 `resume`은 창에서 확인하지 못하면 종료 코드 3, `verify-pr`은 FAIL이면 종료 코드 2, `boot`는 읽지 못한 것이 있으면 종료 코드 1입니다. 거절은 종료 코드 2이고, 설정을 읽는 명령에서 `config.json`이 잘못된 경우도 그렇습니다.

## 레인이 시작되는 방법

1. `seori start <key> --brief FILE`은 먼저 herdr의 omp 연동과, 컴퓨터에 레인을 열 자리가 있는지 확인합니다([컴퓨터 자원 감시](#컴퓨터-자원-감시-can-launch-무거운-작업-자리) 참고, `--force`면 자리 확인을 건너뜀). 읽을 수 없는 Done 줄(`--done`)은 거절합니다.
2. 그 레인 폴더의 교훈([교훈](#교훈) 참고), 브리프, 레인 규칙을 합쳐 `~/.seori/briefs/<key>.md`에 씁니다.
3. 새 탭을 열고, 그 창에서 `herdr agent start`(`--kind omp`)로 omp를 켭니다. omp가 입력을 받을 준비가 되면 바로 돌아옵니다. 이때 프롬프트는 넘기지 않습니다. 넘기면 첫 작업이 끝날 때까지 기다리다가 시간 초과가 나기 때문입니다.
4. 이어서 `herdr agent prompt`로 `/goal` 명령을 보냅니다. 목표에는 브리프 위치와 레인 이름이 들어갑니다. omp는 목표 모드로 바뀌고, 목표를 이룰 때까지 계속 일합니다.
5. 레인은 `working`으로 기록되고(주어졌다면 Done 줄, `--thread`, 한도도 함께), 리드는 `[START <key>]`를 받습니다.

레인 규칙은 omp에게 이렇게 시킵니다: 첫 답에서 결과물과 끝나는 조건을 다시 말할 것, 그리고 `seori ready`가 성공하기 전에는 목표를 완료 처리하지 말 것. 그 뒤 레인은 `[REPORT <key>]`(밖의 일 때문에 막혔으면 `[REPORT <key> WAITING]`)를 보내고, 마지막에 증거 링크와 함께 `[READY <key>]`를 보냅니다. 또 한 단계를 끝낼 때마다 체크포인트를 남기고, 재시작이나 압축 뒤에는 `seori checkpoints <key>`로 먼저 읽어 볼 것, 주인이 멈춰 둔 동안에는 아무것도 시작하지 말 것도 시킵니다. 누가 레인을 닫는지도 규칙에 적혀 있습니다: 보통은 리드가 직접 닫고, Done 줄이 있는 레인은 기다리는 시간이 지나면 seori가 닫습니다.

## seori가 지키게 하는 규칙

- 말하는 쪽은 하나: 사람과 이야기하는 건 리드뿐입니다. 레인은 사람에게 할 말을 모두 리드에게 보냅니다. 듀티는 머지하지 않고 사람과 이야기하지 않습니다.
- READY에는 증거가 필요: `seori ready`는 `--evidence` 링크가 하나도 없거나 최종 답이 비어 있으면 거절합니다. `seori done`은 READY가 아닌 레인을 닫지 않습니다. Done 줄이 있는 레인의 READY는 "다 했다"는 주장이고, seori가 닫기 전에 실제로 다시 확인합니다. [완료 조건(Done 줄)과 자동 닫기](#완료-조건done-줄과-자동-닫기)를 보세요.
- 리드와 듀티 창은 방해하지 않고, 레인은 일하는 중에도 메시지를 받음: `seori send`는 먼저 herdr에게 상대 상태를 묻습니다. 쉬는 중이면 바로 전합니다. 목표 모드의 레인은 목표가 끝날 때까지 계속 `working`으로 보이므로, 열려 있는 레인 창에는 일하는 중이어도 바로 전합니다. omp는 이를 작업 중 끼어든 지시(steer)로 받아 처리하고 하던 일을 이어 갑니다. 바쁜 리드나 듀티 창, 그리고 막혀 있는(blocked, 대화 상자가 열린) 창에 온 메시지는 `~/.seori/inbox/`에 모아 두고, 듀티 루프가 창이 받을 수 있을 때 한 번에 전합니다. 창 앞에 omp 대신 셸이 나와 있으면(omp가 꺼졌거나 Ctrl+Z로 멈춘 경우) 절대 입력하지 않습니다. 셸에 입력한 글자는 명령으로 실행되기 때문입니다.
- 10분, 20분, 40분 알림: 10분 동안 보고가 없는 레인에는 `prompts/nudge.md`를 보냅니다. 창이 일하는 중(working)이어도 보냅니다. 목표 모드의 레인은 목표가 끝날 때까지 계속 working으로 보이므로, working만으로는 진행으로 치지 않습니다. 알림은 작업 중 끼어든 지시(steer)로 들어갑니다. 20분에 한 번 더 보내고, 40분이 되면 리드에게 `[ESCALATE <key>]`를 보냅니다. 그래서 레인은 적어도 10분마다 진행 상황을 보고합니다. 새 보고가 들어오면 알림 횟수는 처음부터 다시 셉니다. 기다림(waiting)을 보고한 레인이나 막혀 있는(blocked) 레인은 건드리지 않습니다. READY 전에 창이 사라지면 `[LOST <key>]`로 알립니다.
- 머지 조건: `seori merge`는 PR의 지금 헤드 커밋에 대한 CLEAR 리뷰 기록(`~/.seori/receipts/`)을 요구합니다. 기록은 `seori review`만 남깁니다. 리뷰어는 새로 띄운 비대화형 omp이고, 저장소의 AGENTS.md, 스킬, 규칙, 확장을 읽지 않는 격리된 상태로 돕니다. `gh`로 PR을 읽고, 마지막 줄에 `VERDICT: CLEAR` 또는 `VERDICT: BLOCK`을 딱 한 번 씁니다. 이 줄이 없으면 기록도 없습니다. 그다음 `gh pr checks`에 체크가 하나 이상 있어야 하고, 모두 통과하거나 건너뛰어야 하며, 적어도 하나는 통과해야 합니다. 체크가 하나도 없으면 통과로 보지 않습니다. 마지막으로 verify-pr이 통과해야 합니다([verify-pr과 머지 관문](#verify-pr과-머지-관문) 참고). 리뷰 뒤에 푸시가 있으면 헤드가 바뀌므로 예전 기록은 쓸 수 없습니다.

## 완료 조건(Done 줄)과 자동 닫기

레인을 열 때 Done 줄을 달 수 있습니다. Done 줄은 레인을 닫기 전에 seori가 실제로 다시 확인하는 신호들입니다. 그래서 레인이 "다 했다"고 말해도 그 말만 믿지 않습니다.

```sh
seori start fix-flaky-login --brief brief.md --done 'merged owner/repo#12; command ["bun","test"] stdout~"0 fail"'
```

신호는 `;`로 이어 씁니다(따옴표, 대괄호, 중괄호 안의 `;`는 그 신호의 일부입니다). 맨 앞의 `Done =`은 떼고 읽습니다. 읽을 수 없는 Done 줄은 `seori start`가 거절하고(종료 코드 2), 잘못된 신호를 하나하나 알려 줍니다.

| 신호 | 맞는 조건 |
|---|---|
| `merged owner/repo#N` | `gh pr view`에서 PR이 MERGED이고 머지 커밋이 있음 |
| `closed owner/repo#N` | `gh issue view`에서 이슈가 CLOSED |
| `published pkg@version` | `npm view`로 레지스트리에서 그 버전이 보임 |
| `command ["argv",...] [stdout~"regex"]` | 명령이 0으로 끝남(그리고 출력이 정규식에 맞음). 셸 없이 레인 폴더에서 돌리고, 최대 2분 |
| `file <path> [sha256=<hex>] [json:.a.b=<json>]` | 파일이 있음(레인 폴더 기준 경로, `~`는 홈 폴더). 주었다면 SHA-256 값과 JSON 필드 값도 맞음 |
| `url <http(s) url> [status=N] [body~"regex"]` | GET 요청(리다이렉트 따라감)이 15초 안에 그 상태 코드(기본 200)로 답함. 주었다면 본문도 정규식에 맞음 |

`merged`와 `closed`는 `owner/repo/pull/N`, `owner/repo/issues/N` 형식도 받습니다. `command ["true"]`는 읽히기는 하지만 아무것도 증명하지 못합니다. Done 줄에는 결과 자체(머지된 PR, 파일)를 쓰세요.

Done 줄이 있으면 레인의 READY는 "다 했다"는 주장이 됩니다:

1. `seori ready`를 하면 레인은 `[LEAD] claim recorded; the lane closes in N min unless the lead objects`를 받고, 리드가 받는 `[READY <key>]`에는 `seori object` 명령이 적힌 줄이 하나 더 붙습니다.
2. 기다리는 시간이 끝나기 전에 리드는 주장을 거절할 수 있습니다: `seori object <key> --reason T [--reason T]`. 레인은 이유와 함께 다시 일하는 상태(working)가 되고, `[LEAD] not done: <이유>; keep working and send ready again when fixed`를 받습니다. READY인 레인에만 반대할 수 있고, 이유는 비어 있으면 안 됩니다. 레인이 READY를 새로 보내면 반대는 지워지고 기다림이 처음부터 다시 시작됩니다.
3. 주장 뒤 `closeAfterMin`분(기본 5분, [설정](#설정-configjson) 참고)이 지나면 듀티 루프가 레인을 확인합니다: 모든 신호를 실제로 다시 확인하고, 그다음 푸시 안 된 작업 규칙을 봅니다. 창이 아직 일하는 중이거나 대화 상자에 막혀 있으면 다음 차례로 미룹니다. 신호를 확인하는 사이에 주장이 바뀌었을 때(반대, 멈춤, 새 READY)도 미룹니다. 둘 다 `close-deferred` 듀티 이벤트로 보입니다. 모두 맞으면 창을 닫고 리드에게 `[CLOSED <key>]`를 보냅니다. 하나라도 틀리면 리드가 반대한 것과 똑같이 실패 이유(`<신호> -> <이유>` 형식)로 반대하고, 리드에게 `[NOT-DONE <key>] <이유>`를 보냅니다.

푸시 안 된 작업 규칙: 레인을 닫아서 추적 중인 작업을 잃으면 안 됩니다. seori는 레인 자신의 git 워크트리(브랜치나 폴더 이름이 `<key>` 또는 `<key>-...`인 것)를 보고, 없으면 레인 폴더가 git 저장소일 때 그 폴더를 봅니다. 추적 중인 파일에 커밋하지 않은 변경이 있으면 실패입니다(추적하지 않는 새 파일은 세지 않습니다). 어느 원격에도 없는 커밋이 있어도 실패입니다. 원격이 아예 없는 저장소는 커밋하지 않은 변경만 봅니다. git 상태를 읽을 수 없으면 통과가 아니라 실패로 봅니다.

Done 줄이 있는 레인에 `seori done <key>`를 하면 같은 확인을 하고, 틀린 것이 있으면 이유 목록과 함께 거절합니다. Done 줄이 없는 레인은 리드가 직접 확인하고 닫습니다. `seori done`은 창이 아직 일하는 중이거나 막혀 있는 레인은 닫지 않습니다. 창과 신호를 확인하는 사이에 레인이 바뀌었으면(반대, 멈춤, 새 READY) `lane <key> changed while it was being checked ...; run done again`으로 거절합니다. 멈춰 둔(paused) 레인은 저절로 닫히지 않습니다.

## verify-pr과 머지 관문

`seori verify-pr owner/repo#N`은 GitHub에서 PR을 다시 읽고(`gh api`) 두 가지 규칙을 확인합니다:

- 커밋 신원: 모든 커밋의 작성자(author)와 커미터(committer) 이메일이 `config.json`의 그 저장소 `repoIdentities` 항목 이메일과 같아야 합니다(대소문자 무시). `noreply@github.com`은 머지 커밋의 커미터일 때만 받아 줍니다. GitHub 화면에서 머지하면 GitHub가 그렇게 커밋하기 때문입니다. 항목이 없는 저장소는 신원을 확인하지 않습니다. 결과에 `IDENTITY skipped (no repoIdentities entry for owner/repo)`라고 나오고, 테스트 규칙만 봅니다.
- 수정에는 테스트: `fix:` 커밋(`fix(scope):`, `fix!:`도 포함)이 소스 파일을 바꾸면, PR에 테스트 파일 추가나 수정이 있어야 합니다. 없으면 PR 본문에 `No test: <이유>` 줄이 있어야 하고, 그러면 실패 대신 경고가 됩니다. 수정 커밋 하나에 자기 테스트가 없는 것은 경고일 뿐이고, 테스트는 PR 전체로 판단합니다.

테스트 파일은 `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`, `*_test.py`, 또는 `test/`, `tests/`, `__tests__/` 아래의 코드 파일입니다. fixture, helper, fake, mock, `setup`, `conftest`, `test-utils` 파일은 세지 않습니다. 소스 파일은 테스트, 문서, fixture 밖의 코드나 스타일 파일입니다.

PR은 커밋을 훑기 전과 후에 한 번씩 읽습니다. 그 사이에 헤드, 본문, 커밋 수가 바뀌었거나 GitHub를 끝까지 읽지 못하면 FAIL입니다. 반쯤 읽은 PR로 판정하지 않습니다. 출력은 `PASS|FAIL owner/repo#N at <sha>` 한 줄, 그다음 `- <실패>` 줄, `IDENTITY skipped (...)` 줄, `WARNING <메모>` 줄입니다. PASS면 종료 코드 0, FAIL이면 2입니다.

`seori merge`는 리뷰 기록과 체크를 확인한 뒤 verify-pr을 돌립니다. FAIL이면 `MERGE_REFUSED verify-pr failed:`와 verify-pr의 출력으로 머지를 거절합니다.

## 교훈

교훈(lesson)은 레인이 같은 저장소의 다음 레인에게 남기는 한 줄짜리 규칙입니다.

```sh
seori done fix-flaky-login --lesson 'run the login tests 20 times before calling a flake fixed'
seori lesson add fix-flaky-login --rule '...' --evidence https://github.com/owner/repo/pull/12
seori lesson add --cwd ~/src/app --rule '...' --evidence '...'
seori lesson list [--cwd DIR]
seori lesson mark <id> --outcome helped|no-effect|harmful|encoded
```

- 교훈은 폴더 하나에 속합니다: 레인 폴더(`lesson add <key>`, `done --lesson`)나 `--cwd DIR`(이때 레인 이름은 `lead`로 기록)입니다. 경로는 실제 경로로 바꿔서 정확히 같은 것만 맞춥니다.
- `seori start`는 레인 폴더의 `pending`이나 `helped` 교훈 가운데 최근 것을 8개까지 브리프 맨 위 `## Lessons for this repo` 아래에 넣습니다.
- 새 교훈은 `pending`이고, `lesson mark`로 결과를 기록합니다. `no-effect`, `harmful`, `encoded`로 표시한 교훈은 더 이상 브리프에 들어가지 않습니다.
- `done --lesson`은 레인 닫기를 막지 않습니다. 증거는 `--evidence`, 없으면 레인의 READY 증거, 그것도 없으면 Done 줄을 씁니다. 교훈이 거절되면 `DONE` 뒤에 `LESSON_WARNING <이유>`를 출력합니다.
- 규칙은 400자 이하 한 줄, 증거는 2000자 이하 한 줄입니다.
- 출력: 추가하면 `LESSON <id> pending <lane> <cwd>`, 표시하면 `MARKED <id> <outcome>`. `lesson list`는 교훈마다 `<id> <outcome> <추가 시각> <lane> <cwd>` 한 줄과 들여 쓴 규칙, 증거 줄을 보여 주고, 없으면 `EMPTY`입니다.

`$SEORI_HOME/lessons.jsonl`은 뒤에 덧붙이기만 합니다. 표시하면 같은 기록을 새 결과로 한 번 더 덧붙이고, id마다 마지막 기록이 이깁니다. 망가진 줄은 건너뛰고 `LESSON_WARNING <경로>:<줄>: <이유>`로 알려 줍니다. 그래서 줄 하나가 망가져도 나머지는 그대로 씁니다.

## 체크포인트

체크포인트 기록은 레인이 끝낸 단계의 목록입니다. 레인이 죽거나, 재시작되거나, 압축된 뒤 다시 일할 때 무엇을 끝냈는지 알 수 있고, 밖에 영향을 준 일(푸시, 머지, 배포)을 두 번 하지 않게 됩니다.

```sh
seori checkpoint fix-flaky-login --step push-fix --result 'pushed the fix branch' --evidence https://github.com/owner/repo/pull/12 --remote-effect push:fix-flaky-login@abc1234
# CHECKPOINT fix-flaky-login push-fix recorded
seori checkpoints fix-flaky-login
```

- 레인 규칙은 단계를 하나 끝낼 때마다 체크포인트를 남기고, 재시작이나 압축 뒤 다시 일하기 전에 `seori checkpoints <key>`를 돌리라고 시킵니다.
- `--evidence`(하나 이상)와 `--remote-effect`는 여러 번 줄 수 있고, 값은 모두 한 줄입니다. remote effect는 끝낸 바깥 작업 하나의 영수증입니다.
- 같은 단계를 같은 내용으로 다시 기록하면 아무것도 바뀌지 않습니다(`CHECKPOINT <key> <step> unchanged (recorded <시각>)`). 같은 단계를 다른 내용으로 기록하면 거절하고, 다른 단계에 이미 기록된 remote effect도 거절합니다.
- `seori checkpoints <key>`는 단계마다 `<시각> <step>: <result>`와 들여 쓴 증거, remote effect 줄을 보여 주고, 없으면 `EMPTY <key>`입니다. 기록에 망가진 줄이 있으면 그 줄을 알려 주며 멈춥니다. 다 읽을 수 없는 기록으로 일을 이어 가면 안 되기 때문입니다.
- key는 seori가 아는 레인(열려 있든 닫혔든)이어야 합니다. 기록은 `$SEORI_HOME/checkpoints/<key>.jsonl`이고, 잠금을 잡고 써서 디스크에 확실히 기록한 뒤에 답합니다.

## 멈추기와 다시 켜기

```sh
seori pause fix-flaky-login --note 'owner said wait'
# PAUSED fix-flaky-login goal paused
seori resume fix-flaky-login
# RESUMED fix-flaky-login as working, goal resumed
```

`seori pause <key>`는 레인의 omp에 `/goal pause`를 보내고, 창에 그 결과(`Goal mode paused.` 또는 `Warning: No active goal to pause.`, 어느 쪽이든 목표가 저절로 이어지지 않음)가 보일 때만 레인을 `paused`로 기록합니다. 그 뒤 3초쯤 창을 지켜보다가 차례가 돌고 있거나 새로 시작되면 Escape를 한 번 눌러 끊습니다. 그래서 막 시작하려던 차례도 멈춥니다. 일하는 중, 기다리는 중, READY인 레인을 멈출 수 있고, 이미 멈춘 레인이면 `PAUSED <key> already`를 출력합니다. `seori resume <key>`는 `/goal resume`을 보내고 `Goal mode resumed.`(또는 `Warning: No paused goal to resume.`)를 기다린 뒤, 멈추기 전 상태로 돌려놓고 조용했던 시간을 처음부터 다시 셉니다. 그래서 오래 멈췄다가 다시 켜도 바로 깨우기 알림이나 멈춤 알림이 가지 않습니다. `--note`는 레인 기록에 남습니다.

창에서 6초쯤 안에 확인하지 못하면 `PAUSE_UNVERIFIED <key> ...`나 `RESUME_UNVERIFIED <key> ...`를 출력하고 종료 코드 3으로 끝나며, 레인은 그대로 둡니다. 레인이 아직 돌고 있을 수 있으니 창을 보고 다시 시도하세요.

멈춘 레인에는 깨우기 알림도, 한도나 멈춤 알림도 가지 않습니다. 멈춘 레인이 감시나 메시지에 깨어나 보고를 보내도 그 보고는 리드에게 가지만, 멈춤은 풀리지 않습니다. 멈춤은 `seori resume`으로만 풉니다. 멈춘 레인의 창이 듀티 차례 두 번 연속 일하는 중으로 보이면, 일하는 구간마다 한 번씩 리드에게 `[WORKING-WHILE-PAUSED <key>]`를 보냅니다. 레인은 멈춘 상태로 남습니다. 멈춘 레인의 창이 사라지면 다른 레인처럼 사라진(lost) 레인으로 기록하고 리드에게 `[LOST <key>]`를 보냅니다. 리드 규칙은 주인이 잠깐, 멈춰, 기다려(wait, stop, hold on)라고 하면 같은 차례 안에 멈추라고 시킵니다.

## 감독(한도와 멈춤)

듀티 루프는 열린 레인마다 두 가지를 지켜보고, 각각 한 번씩 리드에게 알립니다. seori는 이 일로 레인에 메시지를 보내거나, 멈추거나, 끄지 않습니다. 결정은 리드가 합니다.

한도. 레인마다 걸린 시간, 토큰, 비용 한도를 둘 수 있습니다. `seori start --wall-minutes N --token-limit N --cost-limit N`은 그 레인 하나의 한도를 정합니다. `none`은 그 한도를 끄고, 빠진 플래그는 설정의 기본값을 씁니다. 이 플래그를 하나도 주지 않은 레인은 `config.json`의 `supervision.defaults`를 따르고, 기본값은 모두 꺼져 있습니다. 걸린 시간은 레인을 연 때부터 셉니다. 토큰과 비용은 레인 omp 세션 파일(경로는 herdr가 알려 줌)의 어시스턴트 메시지에서 더합니다. 읽을 수 없는 값은 한도에 닿지 않은 것으로 보고, `usage-unknown` 듀티 이벤트로 한 번 보여 줍니다. 한도에 닿으면 리드에게 `[BLOCKED <key>] <종류> ceiling reached (<값>, limit <한도>); the lane keeps running until you decide`를 보냅니다. 한도마다, 한도 값마다 한 번이고(리드가 한도를 올리면 거기에 닿을 때 다시 알림), 레인 기록에도 남습니다.

멈춤. herdr가 일하는 중으로 보는 working 레인이 `supervision.hungAfterMin`분(기본 20분) 동안 보고도 없고 파일도 바꾸지 않으면, 멈춘 것으로 보고 `[STALLED <key>] ...`를 보냅니다. 멈출 때마다 한 번입니다. 파일 변경은 새 HEAD, 또는 레인 폴더에서 `git status`가 보여 주는 파일들(`node_modules` 제외)의 시각과 크기 변화입니다. git 저장소가 아니면 보고만 진행으로 칩니다. waiting 레인은 기다린다고 말했으니 조용해도 멈춤이 아닙니다. 변경 기록은 `duty/supervision.json`에 둡니다.

## 작업 기록(worklog)

작업 기록은 주인의 요청을 리드가 적어 두는 곳입니다. 그래서 리드가 압축되거나 재시작되어도 기억이 아니라 기록에서 이어 갑니다.

```sh
seori worklog add 'Fix the flaky login test' --source telegram:123:456
seori worklog next 1a2b3c4d 'open a lane once CI is green'
seori worklog note 1a2b3c4d 'lane fix-flaky-login started'
seori worklog close 1a2b3c4d --result 'merged owner/repo#12'
seori worklog list --open
```

- `add`는 항목에 16진수 8자리 id를 줍니다. `next`는 다음 할 일을 바꾸고, `note`는 메모를 더하고, `close`는 결과와 함께 끝냅니다. 모두 저장된 항목을 JSON 한 줄로 출력합니다. 없는 항목이나 닫힌 항목은 바꿀 수 없습니다(종료 코드 2).
- 제목(200자 이하), 출처(400자 이하), next, note, 결과(1000자 이하)는 모두 한 줄입니다.
- `list`는 항목을 오래된 것부터 들여 쓴 JSON으로 출력합니다(`--open`: 열린 것만). 망가진 줄마다 stderr에 `WORKLOG_WARNING <내용>`을 씁니다.
- `$SEORI_HOME/worklog.jsonl`이 원본 기록입니다. 뒤에 덧붙이기만 하고 바꿀 때마다 한 번에 쓰므로, 여럿이 동시에 써도 줄을 잃지 않습니다. `$SEORI_HOME/worklog.md`는 바꿀 때마다 원본에서 다시 만들고, 열린 항목이 먼저 나옵니다. seori는 자기가 쓴 `worklog.md`만 덮어씁니다(첫 줄에 표시가 있음). 다른 파일이 있으면 그 파일을 옮길 때까지 명령을 거절합니다.

리드 규칙: 요청이 오면 바로 `add`, 진행하면서 `next`와 `note`, 끝나면 결과와 함께 `close --result`.

## 부팅 점검(boot)

`seori boot`는 리드가 재시작, `/new`, 압축 뒤에 기억대로 움직이기 전에 돌리는 읽기 전용 점검입니다. 아무것도 바꾸지 않습니다: 레인이나 역할을 쓰지 않고, 다시 띄우지 않고, 감시를 멈추지 않고, 메시지를 닫지 않고, 파일도 만들지 않습니다. 출력 줄은 이 순서입니다:

- `CONFIG`(ok, defaults, invalid)와 `MESSENGERS`
- `LEAD`, `DUTY`: 창과 상태
- `PANES`(요약), `VANISHED`(창이 사라진 열린 레인. 기록은 남기고 다시 띄우지 않음), `UNREGISTERED`(어느 역할이나 열린 레인의 것도 아닌 에이전트 창)
- 열린 레인마다, 해당되면 `READY`(언제부터, 몇 분째 기다림, `done=signals` 또는 `done=by-hand`)와 `PAUSED`, 그다음 마지막 보고인 `REPORT` 또는 `NO-REPORT`
- `WORKLOG open=N`과 열린 작업 기록 항목마다 `OPEN` 줄
- `CHANNEL open=N`과 열린 리드 채널 메시지마다 `MSG` 줄
- `WATCHES`와, 주인 레인이 닫힌 살아 있는 감시마다 `ORPHAN-WATCH`(멈추는 명령 포함)
- `DAEMON` heartbeat 나이(fresh 또는 stale)와 메신저마다 `MESSENGER` 상태 줄
- `BOOT checked` 또는 `BOOT incomplete`

사라진 레인이나 오래된 heartbeat 같은 발견은 실패가 아닙니다. 읽지 못한 입력이 있을 때만 종료 코드 1이고, 그런 입력은 저마다 따로 한 줄로 나옵니다.

## 컴퓨터 자원 감시, can-launch, 무거운 작업 자리

자원 감시(host guard)는 컴퓨터 상태를 한 번에 읽습니다: 코어당 1분 부하(퍼센트, 100 = 모든 코어가 바쁨), 남은 메모리, `$SEORI_HOME`이 있는 디스크의 남은 공간(`df -k -P`), 살아 있는 herdr 창 수(`herdr pane list`).

- `seori can-launch`는 `CAN_LAUNCH`(종료 코드 0)나 `HOLD <이유> | <이유>`(종료 코드 4)를 출력합니다. 남은 메모리가 `guard.memFreeMinPct`보다 적거나, 남은 디스크가 `guard.diskFreeMinGb`보다 적거나, 창이 `guard.panesMax`보다 많으면 새 레인을 막습니다(HOLD). CPU 부하로는 막지 않습니다. 너무 빨리 바뀌어서 계획에 쓸 수 없기 때문입니다(대신 무거운 명령이 부하를 기다립니다). 읽지 못한 값으로는 막지도 알리지도 않습니다. 그래서 `df`나 herdr 호출이 한 번 실패해도 모든 일이 멈추지 않습니다. `seori guard`에서는 `unknown`으로 보입니다.
- `seori start`도 같은 확인을 합니다. 자리가 없으면 `HOLD` 줄과 `lane <key> not started; queue it (seori backlog add) or pass --force`를 출력하고 종료 코드 4로 끝납니다. `--force`면 확인을 건너뜁니다. 리드 규칙은 레인을 열기 전에 `seori can-launch`를 돌리고, HOLD면 일을 백로그에 넣으라고 시킵니다.
- `seori guard`는 `HOST load N% per core, memory free N%, disk free N GB, panes N`과 `HOST_GUARD OK` 또는 `HOST_GUARD ALERT <이유>`를 출력합니다. 읽기만 합니다.
- 듀티 루프는 기준을 넘으면 리드에게 `[HOST-GUARD ALERT] <이유>`를, 모두 다시 괜찮아지면 `[HOST-GUARD CLEAR] <값>`을 보냅니다. 넘을 때마다 한 번씩입니다(상태는 `duty/guard.json`). 부하는 `guard.loadAlertPct`를 넘으면 알리고, `guard.loadOkPct` 밑으로 떨어질 때까지 높은 상태로 봅니다. 그래서 기준 근처에서 오르내려도 알림이 계속 바뀌지 않습니다. 메모리, 디스크, 창 수는 레인을 막는 기준과 같은 기준으로 알립니다. 한 번 울린 알림은 값을 제대로 읽어서 괜찮을 때만 풉니다. 읽지 못한 값이 있는 동안에는 알림을 그대로 두므로, 잘못된 CLEAR 뒤에 ALERT가 다시 오는 일이 없습니다.

`seori heavy <label> -- <cmd...>`는 전체 빌드나 큰 테스트를, 코어당 부하가 `heavy.maxLoadPct`보다 낮고 `heavy.slots`개 자리 가운데 하나가 비었을 때만 돌립니다. 그래서 여러 레인이 한꺼번에 컴파일하지 않습니다. 기다리는 동안 이유가 바뀔 때마다 stderr에 `HEAVY <label> waiting: <이유>`를 출력하고, 15초마다 다시 봅니다. 자리 하나는 잠금 파일 `$SEORI_HOME/heavy/<n>.lock`이고, 잡고 있던 프로세스가 죽은 자리는 넘겨받습니다. 명령은 셸 없이 seori의 터미널에서 돌고, seori는 그 명령의 종료 코드로 끝납니다(시그널로 끝났으면 128 + 시그널 번호). SIGTERM과 SIGHUP은 명령에 넘기고, Ctrl-C는 seori를 먼저 끝내지 않고 명령에 닿게 해서, 명령이 끝나야 자리가 풀립니다. 듀티 프롬프트는 무거운 명령을 이렇게 돌리라고 시킵니다.

`seori heavy <label>`에 `--`와 명령이 없으면 거절합니다(종료 코드 2).

## 주인 스레드에 진행 상황 올리기

메신저 메시지 때문에 연 레인에는 그 메시지의 리드 채널 id를 달 수 있습니다: `seori start <key> --brief FILE --thread <id>`. id는 리드가 그 메시지에서 보는 것, 즉 `<source>:<chat>:<message id>`입니다(`seori msg list`에 나오는 것). 그러면 듀티 루프가 레인의 최신 보고를 그 메시지 아래 스레드 답글로 `[<key>] <보고 내용>` 형태로 올립니다. 최대 `progressEveryMin`분(기본 15분, 레인을 연 때나 마지막으로 올린 때부터)마다 한 번이고, 보고가 바뀌었을 때만, 레인이 working이나 waiting일 때만 올립니다. 올리기 전에 홈 폴더는 `~`로, herdr 창 id는 `<pane>`으로 바꿉니다.

갔는지 확실하지 않은 글은 올린 것으로 치고, 두 번 보내지 않습니다. 확실히 실패했거나, 그 source의 메신저가 설정되지 않았거나, 스레드 id가 그 형식이 아니면 `post-failed` 듀티 이벤트가 되고 다음 차례에 다시 시도합니다. 올린 글은 레인 기록에 남습니다.

## 메신저 채널

리드는 자기 창뿐 아니라 메신저로도 요청을 받을 수 있습니다. 메신저 설정은 `$SEORI_HOME/messengers.json`에 씁니다:

```json
{ "messengers": [ { "source": "fake", "owner": "u1" } ] }
```

`source`는 어떤 메신저인지(`telegram`, `slack`, `discord`, 시험용 `fake`), `owner`는 리드에게 말할 수 있는 단 한 명의 보낸 사람 id입니다. 다른 사람이나 봇이 보낸 메시지는 버립니다. 이 id는 `seori msg pair`로 찾을 수 있습니다([주인 등록](#주인-등록) 참고). 안전 규칙은 이것뿐이고 dori와 같습니다. 주인만 리드에게 말할 수 있고, 주인의 메시지에는 따로 제한을 두지 않습니다. `options.apiBase`로 다른 API 주소를 쓸 수 있습니다(시험에서는 가짜 서버를 씁니다).

토큰은 `$SEORI_HOME/secrets.json`에 씁니다. 이 파일은 `chmod 600`이어야 합니다(다른 사람이 읽을 수 있으면 seori가 거절합니다). 환경 변수가 있으면 그쪽이 먼저입니다:

```json
{ "telegram": { "token": "123:abc" }, "slack": { "botToken": "xoxb-...", "appToken": "xapp-..." }, "discord": { "token": "..." } }
```

| source | 만들 것 | `owner` | 환경 변수 |
|---|---|---|---|
| `telegram` | @BotFather로 봇을 만들고, DM으로 `/start`를 한 번 보냅니다. 그룹이나 토픽에서 쓰려면 privacy mode를 끕니다(`/setprivacy`) | 숫자로 된 내 사용자 id | `SEORI_TELEGRAM_TOKEN` |
| `slack` | 워크스페이스에 앱을 만들고 Socket Mode를 켭니다. 앱 토큰(`connections:write`), 봇 권한 `chat:write`, `im:history`(채널에서도 쓰려면 `app_mentions:read`, `channels:history`), 봇 이벤트 `message.im`, Messages 탭 켜기 | 내 멤버 id(`U...`) | `SEORI_SLACK_BOT_TOKEN`, `SEORI_SLACK_APP_TOKEN` |
| `discord` | 애플리케이션과 봇을 만들고 MESSAGE CONTENT 인텐트를 켭니다(DM만 쓸 거면 `options.intents`에서 빼도 됩니다). 봇에게 DM을 한 번 보냅니다 | 내 사용자 id | `SEORI_DISCORD_TOKEN` |

`seori msg check`는 설정된 메신저마다 봇이 누구인지 물어봅니다. 토큰이 맞는지 이걸로 확인합니다. 메신저마다 `OK <source>: <봇 이름>`이나 `FAIL <source>: <이유>`를 출력하고, 하나라도 실패하면 종료 코드 1입니다. `seori msg check <source>`는 그 메신저 하나만 확인하고, `messengers.json`에 아직 항목이 없어도 됩니다. 토큰만 있으면 됩니다.

### 주인 등록

`seori msg pair <source>`는 설정할 때 주인의 보낸 사람 id를 찾아 줍니다. `telegram`, `slack`, `discord`, `fake`에서 됩니다:

```sh
seori msg pair telegram --write
# PAIRING telegram: send the bot any direct message now (waiting up to 10 min)
# CANDIDATE telegram id=123456789 chat=123456789 text="hi"
# PAIRED telegram owner=123456789 in ~/.seori/messengers.json; a running seori daemon restarts on the change
```

- seori는 메신저의 받기 기능을 등록 모드로 돌립니다. 이 모드에서는 봇이 아닌 누구든 보낸 새 DM이 통과하고, 보낸 사람마다 `CANDIDATE` 줄(내용 앞 40자 포함)을 출력합니다. 첫 사람이 오면 멈춥니다. `--all`을 주면 기다리는 시간 내내 듣고 보낸 사람을 모두 보여 줍니다. `--minutes N`으로 기다리는 시간을 정합니다(기본 10분).
- 등록할 때는 데몬 커서의 임시 복사본으로 읽으므로, 데몬이 이어 받을 위치는 절대 움직이지 않습니다. 등록 중에 지나친 메시지도 나중에 리드에게 갑니다.
- `--write`는 첫 사람을 그 source의 `owner`로 `messengers.json`에 기록합니다. 항목이나 파일이 없으면 만들고, 다른 항목과 필드는 그대로 둡니다. `--write`와 `--all`을 함께 쓰면 거절합니다. 믿기 전에 CANDIDATE 내용이 주인이 보낸 것과 같은지 확인하세요.
- 등록을 시작하기 2분보다 전에 보낸 메시지와 고친 메시지는 무시합니다. 그래서 메신저에 남아 있던 낯선 사람의 옛 메시지가 주인이 되는 일은 없습니다.
- 등록 모드는 `msg pair`만 켤 수 있습니다. `messengers.json`으로는 켤 수 없으므로 데몬은 낯선 사람을 받지 않습니다.
- 데몬이 돌고 있고(heartbeat가 30초 이내) 그 source가 이미 `messengers.json`에 있으면 거절합니다. 봇 하나를 둘이 읽으면 부딪치기 때문입니다(텔레그램은 409로 답함). 항목을 넣기 전에 등록하거나, 데몬을 먼저 멈추세요.
- 이미 주인이 적힌 `telegram` 항목은 `--force` 없이는 거절합니다. 텔레그램은 다음 메시지를 읽으면 그 앞 메시지를 서버에서 처리 끝으로 표시하므로, 등록하면 데몬 몫으로 쌓여 있던 메시지(데몬이 멈춘 동안 온 것)가 버려지기 때문입니다. 데몬이 먼저 전하게 두거나, 그래도 등록하려면 `--force`를 붙이세요.
- 기다리는 시간 안에 메시지가 없으면 거절입니다(종료 코드 2). Ctrl-C로 일찍 끝낼 수 있습니다.

### 받기

메신저마다 어디까지 받았는지(커서)를 `$SEORI_HOME/messenger/<source>/`에 남기는데, 메시지를 저장한 뒤에만 커서를 옮깁니다. 그래서 중간에 죽어도 메시지를 잃지 않고 다시 받습니다:

- 텔레그램은 `getUpdates`로 기다리며 받습니다. 봇 토큰 하나에 프로그램 하나만 받을 수 있습니다(둘이면 텔레그램이 409로 답하고, seori가 알려 줍니다). 텔레그램은 읽지 않은 메시지를 24시간만 보관합니다.
- 슬랙은 Socket Mode를 씁니다(공개 주소가 필요 없습니다). 저장한 뒤에야 받았다고 알립니다. 다시 연결될 때마다 본 적 있는 대화를 커서부터 `conversations.history`로, 최근 스레드는 `conversations.replies`로 읽어서, 연결이 끊긴 동안 온 메시지와 스레드 답글도 놓치지 않습니다. 읽기 권한이 없는 대화는 건너뛰고, ping에 답하지 않는 연결은 다시 연결합니다.
- 디스코드는 게이트웨이를 쓰고, 다시 켜지면 세션을 이어 갑니다(resume). 이어 갈 수 없으면 본 적 있는 대화를 커서부터 REST로 읽습니다.

고친 메시지는 `(edited)`로 시작하는 새 메시지로 리드에게 갑니다. 첨부 파일은 내려받지 않고 `[attachment: 이름 (종류, 크기) 참조]` 줄로 적습니다. 긴 답은 메신저 한도(4096, 3900, 2000자)에 맞춰 문단, 줄, 단어 경계에서 나눠 보내고, 첫 조각이 원래 메시지에 답글(스레드)로 붙습니다. 첫 조각이 간 뒤에 실패하면, 갔을 수도 있는 다른 보내기처럼 불확실로 기록합니다.

`fake`는 `$SEORI_HOME/messenger/fake/` 아래 파일로 움직입니다. `in.jsonl`에 `{"msgId":"1","chat":"c1","from":"u1","text":"..."}` 한 줄을 덧붙이면 리드에게 메시지를 보낸 것이 되고, 답은 `out.jsonl`에 쌓입니다. `send-mode`에 `ok`, `timeout`, `error`를 쓰면 보내기가 성공, 불확실, 실패로 끝납니다.

메시지가 가는 길:

1. 데몬(`seori up`의 다섯 번째 창)이 메시지를 받습니다. 주인이 보낸 것이면 먼저 `$SEORI_HOME/lead/`에 저장하고(디스크에 확실히 기록), 그다음에야 메신저에 받았다고 알립니다. 같은 메시지가 두 번 와도 한 번만 저장합니다. 데몬은 몇 초마다 살아 있다는 표시(heartbeat)를 남깁니다. 창에서 다시 켜기 루프로 돌기 때문에, 데몬이 죽어도 1초쯤 뒤에 다시 켜집니다. `messengers.json`이 바뀌면(새로 만들기, 고치기, 지우기) 데몬이 스스로 끝나고 루프가 새 설정으로 다시 켭니다. 그래서 `seori up` 뒤에 메신저를 설정해도 됩니다. `messengers.json`을 읽을 수 없으면 그 창에 오류를 남기고, 파일이 바뀔 때까지 메신저 없이 돕니다(heartbeat와 감시는 계속 돕니다). 그 창에서 Ctrl-C를 누르거나(종료 코드 130) 데몬 프로세스를 `kill`하면(143) 데몬과 루프가 함께 멈춥니다. SIGHUP(129, 창을 닫을 때도 이 신호가 갑니다)을 받으면 데몬은 감시 명령까지 깔끔하게 멈추고, 루프가 아직 돌고 있으면 루프가 다시 켭니다. `$SEORI_HOME` 하나에 데몬은 하나만 돕니다(`messenger/daemon.lock`).
2. 리드의 omp는 `extensions/lead-channel.ts`를 불러옵니다. 리드만 불러오고, 듀티, 레인, 리뷰어는 불러오지 않습니다. 이 확장이 저장된 메시지를 id와 함께 리드의 대화에 넣고, 넣을 때마다 기록(ledger)을 남깁니다. omp를 다시 켜거나 `/new`, `/resume`, `/fork`를 해도 답하지 않은 메시지는 남아 있습니다.
3. 리드는 `seori msg send --reply-to <id> --text '...'`로 답하고, 답할 필요가 없으면 `seori msg close <id> --why '...'`로 닫습니다. 메신저가 받아 준 답이나 닫기만 id를 끝냅니다. 같은 id에 두 번 답하려 하면 거절합니다. 갔는지 확실하지 않은 답(보낸 뒤 시간 초과)은 기록해 두고, 사람이 채팅을 확인하고 `--again`을 붙이기 전까지 다시 보내지 않습니다.
4. 아직 답하지 않은 id는 다시 전합니다. 모두 합쳐 3번까지 전하고, 그래도 답이 없으면 포기합니다.

메신저가 설정되어 있으면 듀티 루프가 채널도 지켜봅니다. `messengers.json`을 읽을 수 없으면(그동안 데몬은 메신저를 받지 않습니다) 리드에게 한 번 알리고, 데몬의 heartbeat가 90초보다 오래되어도 리드에게 한 번 알립니다. 어떤 메신저가 3분 동안 받지 못하고 있으면(토큰이 거절됨, 같은 텔레그램 봇을 다른 프로그램이 읽음, 디스코드 인텐트가 꺼짐, 메신저 서버가 2분 동안 답하지 않음 등) 오류 내용과 함께 리드에게 한 번 알립니다. 데몬은 받기가 계속 실패하는 동안 `messenger/<source>/health.json`을 남기고, 실패한 메신저를 점점 드물게 다시 켭니다(5초에서 두 배씩 늘려 최대 10분. 설정 오류로 디스코드의 하루 접속 한도를 다 쓰지 않도록). 메시지가 하나라도 들어오거나 3분 넘게 잘 돌면 파일을 지우고, `messengers.json`을 고치면 처음부터 다시 셉니다. 그리고 리드가 꺼져 있거나(메시지를 받아 가는 리드 omp가 없음) 2분 넘게 막혀 있으면(herdr가 blocked라고 보고함: 터미널에서 질문을 기다리거나, 모델 오류로 차례가 끝난 경우), 또는 3번 전하고도 포기한 메시지가 있으면, 메시지마다 한 번씩 채팅으로 사람에게 알립니다. 답이 이미 갔을 수도 있는 메시지(send-uncertain)나 포기한 메시지는 다시 전하지 않으므로, 꺼져 있다거나 막혀 있다는 알림도 보내지 않습니다.

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

- `--command CMD [--filter RE] [--cwd DIR]`: 오래 도는 셸 명령입니다. 출력 줄 가운데 정규식에 맞는 줄(`--filter`가 없으면 모든 줄)이 알림이 되고, 한꺼번에 나온 줄은 알림 하나로 묶입니다(알림 하나에 40줄까지, 64 KiB보다 긴 줄은 잘림). 명령이 0으로 끝나면 감시도 끝납니다(done). 명령이 죽으면(0이 아닌 종료 코드나 시그널) 조금씩 기다렸다가 연달아 3번까지 다시 띄우고, 그래도 죽으면 감시를 멈춥니다. 마지막 대기 시간보다 오래 잘 돌았다면 그 횟수는 처음부터 다시 셉니다. 데몬이 정리 없이 죽었다면, 다시 켜진 데몬이 남겨진 명령을 먼저 끄고 새로 띄웁니다.
- `--file PATH`: 파일이나 디렉터리입니다. 생기거나 바뀌거나 지워질 때마다 알림이 갑니다. 데몬이 꺼져 있던 사이에 바뀐 것도 알립니다. 디렉터리는 안쪽 전체를 봅니다(가장 최근 변경, 전체 크기, 항목 수; 항목 10,000개, 깊이 8단계까지, 심볼릭 링크는 따라가지 않음).
- `--checks OWNER/REPO#N`: PR의 체크입니다. 모든 체크가 끝나면(통과든 실패든) 알림 하나를 보내고 끝납니다.
- `--pane PANE --status idle|working|blocked|gone`: herdr 창의 에이전트 상태입니다. 그 상태가 되면 알림 하나를 보내고 끝납니다(`idle`은 herdr의 `done`도 포함).

음소거된 감시는 놓친 알림 수만 셉니다. 감시마다 기록 파일은 약 1 MiB로 유지합니다(오래된 부분은 `<id>.events.jsonl.1`로 옮김).

주인: 레인 창에서 걸면(`SEORI_LANE`이 있으면) 그 레인을, 아니면 리드를 깨웁니다. `--for lead`나 `--for <레인 키>`로 다른 주인을 정할 수 있습니다. 감시는 어느 에이전트든 걸 수 있고, 확인을 묻지 않습니다. 알림은 모두 `[watch <이름> <id>]`로 시작하며 답할 필요가 없습니다. 리드는 리드 채널로 받습니다(차례 도중에도 전해짐). 종류는 `watch`, id는 `watch:<감시 id>:<번호>`이고, 리드가 보면 저절로 닫힙니다. `seori msg list --all`에 메신저 메시지와 함께 보이며, `seori msg send --reply-to`에 감시 id를 주면 거절합니다. 레인은 자기 창으로 받습니다(다른 레인 메시지처럼 차례 도중에도). 레인이 닫히면 그 레인의 감시도 멈춥니다.

한도:

- 감시는 2시간 동안 살아 있습니다. `--timeout`으로 1초에서 24시간까지 정할 수 있습니다.
- `--persistent`를 주면 7일 동안 살아 있습니다. 주인마다 5개까지이고, 6번째는 거절합니다.
- 깨우기 한도: 한 시간 안에 6번 깨우면 감시가 음소거됩니다. 그 뒤로는 알림을 보내지 않고 세기만 합니다. `seori watch rearm`으로 다시 켜면 한도가 처음으로 돌아가고, 그동안 놓친 알림 수를 알려 줍니다. 이 수는 30초마다 저장되므로, 마지막 알림 뒤 30초 안에 다시 켜면 실제보다 적게 나올 수 있습니다.
- 거절(24시간이 넘는 timeout, 6번째 persistent 감시, 잘못된 `--filter` 정규식, 이미 쓰는 이름)은 종료 코드 2입니다.

`seori watch list`는 감시마다 id, 이름, 주인, 상태, 무엇을 보는지, 지난 시간, 남은 시간, 지난 한 시간 동안 깨운 횟수, 음소거 중 놓친 알림 수를 보여 줍니다. `seori watch log <id|name> [-n N]`는 감시가 본 일과 보낸 알림 중 마지막 N개(기본 20개)를 보여 줍니다. `stop`, `rearm`, `log`는 이름을 `add`가 고를 주인(`--for`, 없으면 `SEORI_LANE`, 그것도 없으면 리드)의 살아 있는 감시 안에서만 찾습니다. 그래서 두 레인이 저마다 `ci`라는 감시를 가져도 됩니다. 그 주인의 감시 여러 개가 같은 이름이면(이름 없는 감시는 종류 이름을 씁니다) id 목록과 함께 거절합니다. id는 주인과 상관없이 통합니다.

omo의 `monitor`와 비교하면: 지켜보는 대상의 종류, 알림 묶기, 깨우기 한도, 7일짜리 감시 5개는 같습니다. 다른 점은 감시가 에이전트 세션이 아니라 seori 안에(`$SEORI_HOME/watches/`에 감시마다 파일 하나) 있다는 것입니다. 그래서 `/new`, omp 재시작, 데몬 재시작에도 살아남고(다시 켜진 데몬이 이어서 돌림), `seori watch list` 하나로 모두 볼 수 있고, 죽은 명령은 저절로 다시 띄우며, PR 체크와 herdr 창 상태를 따로 지켜볼 수 있습니다.

## 설정 (config.json)

`$SEORI_HOME/config.json`은 없어도 되고, 안의 필드도 모두 빼도 됩니다. 파일이 없으면 모두 기본값입니다. 기본값을 모두 적으면 이렇습니다:

```json
{
  "repoIdentities": {},
  "closeAfterMin": 5,
  "progressEveryMin": 15,
  "supervision": { "defaults": { "wallMinutes": null, "tokens": null, "costUsd": null }, "hungAfterMin": 20 },
  "guard": { "loadAlertPct": 150, "loadOkPct": 80, "memFreeMinPct": 10, "diskFreeMinGb": 20, "panesMax": 30 },
  "heavy": { "slots": 1, "maxLoadPct": 80 }
}
```

| 필드 | 기본값 | 뜻 |
|---|---|---|
| `repoIdentities` | `{}` | `"owner/repo": { "name": "...", "email": "..." }`: 그 저장소 커밋에 있어야 할 Git 신원. verify-pr과 머지 관문이 이메일을 확인합니다. 저장소 이름은 대소문자를 무시하고 맞춥니다. 항목이 없는 저장소는 신원을 확인하지 않습니다 |
| `closeAfterMin` | `5` | Done 줄이 있는 레인이 READY 뒤 몇 분 지나면 저절로 닫히는지(리드가 반대하지 않으면) |
| `progressEveryMin` | `15` | `--thread`가 있는 레인의 최신 보고를 최대 몇 분마다 올리는지 |
| `supervision.defaults.wallMinutes` | `null` | 레인마다 걸린 시간 한도(분). `null`은 끔 |
| `supervision.defaults.tokens` | `null` | 레인마다 토큰 한도. `null`은 끔 |
| `supervision.defaults.costUsd` | `null` | 레인마다 비용 한도(미국 달러). `null`은 끔 |
| `supervision.hungAfterMin` | `20` | 보고도 파일 변경도 없이 몇 분 지나면 working 레인을 멈춘 것으로 알리는지 |
| `guard.loadAlertPct` | `150` | 코어당 1분 부하(%)가 이보다 높으면 알림 |
| `guard.loadOkPct` | `80` | 알림을 풀려면 부하(%)가 이보다 낮아져야 함 |
| `guard.memFreeMinPct` | `10` | 남은 메모리(%)가 이보다 적으면 새 레인을 막고 알림 |
| `guard.diskFreeMinGb` | `20` | `$SEORI_HOME` 디스크의 남은 공간(GB)이 이보다 적으면 새 레인을 막고 알림 |
| `guard.panesMax` | `30` | 살아 있는 herdr 창이 이보다 많으면 새 레인을 막고 알림 |
| `heavy.slots` | `1` | `seori heavy` 명령이 동시에 몇 개까지 돌 수 있는지 |
| `heavy.maxLoadPct` | `80` | 무거운 명령은 코어당 부하(%)가 이보다 낮아질 때까지 기다림 |

잘못된 필드는 조용히 기본값으로 넘어가지 않고, 그 필드 이름을 담은 오류가 됩니다. 그래서 오타 하나로 한도가 몰래 꺼지는 일이 없습니다:

- 올바른 JSON이 아니거나 JSON 객체가 아니면 오류입니다.
- 맨 위나 `supervision`, `supervision.defaults`, `guard`, `heavy` 안에 모르는 필드가 있으면, 그 필드와 아는 필드 목록을 담은 오류입니다.
- `repoIdentities`, `supervision`, `supervision.defaults`, `guard`, `heavy`는 객체여야 하고, `repoIdentities` 항목마다 비어 있지 않은 `name`과 `email`이 있어야 합니다.
- 숫자는 모두 유한하고 음수가 아니어야 합니다. 한도는 그런 숫자이거나 `null`입니다. `heavy.slots`는 1 이상의 정수여야 합니다.

설정을 읽는 명령(`start`, Done 줄이 있는 레인의 `ready`, `merge`, `verify-pr`, `can-launch`, `guard`, `heavy`)은 오류를 출력하고 종료 코드 2로 끝납니다. 듀티 루프에서는 설정이 필요한 부분마다 이벤트(`autoclose-failed`, `supervise-failed`, `guard-failed`, `progress-failed`)로 알리고 나머지는 계속 돕니다. `seori boot`에는 `CONFIG invalid`로 나옵니다. 설정은 명령과 듀티 차례마다 새로 읽으므로, 바꾸면 재시작 없이 바로 적용됩니다.

## 서리 모드 스킬

`skills/seori-mode/`는 seori를 설정하고 리드가 일하는 방식을 요약해 둔 omp 스킬입니다. `서리 모드`, `seori mode`, 또는 seori에 붙인 이름으로 "<이름> 모드"라고 하면 omp가 불러옵니다. 스킬 파일은 영어로 쓰여 있지만, 말은 사용자의 언어로 합니다. 단계별 안내는 `references/`의 `setup.md`, `messengers.md`, `onboarding.md`, `writing.md`에 있습니다.

`install.sh`([서리 모드로 빠르게 시작하기](#서리-모드로-빠르게-시작하기)의 한 줄 명령)에는 git과 Bun 1.3 이상이 필요합니다. 하는 일:

- 저장소를 `~/.seori/src`에 받습니다(`SEORI_SRC`로 다른 곳 지정). 이미 있으면 fast-forward로 업데이트합니다. 그 폴더에 내 작업이 있으면 멈추고, 그대로 두는 방법(`SEORI_NO_PULL=1`이면 지금 상태 그대로 설치)과 버리는 방법을 알려 줍니다.
- `bun install`과 `bun link`를 돌려, Bun의 전역 bin 폴더를 통해 `seori`를 PATH에 넣습니다.
- 스킬을 `~/.omp/agent/skills/seori-mode`에 링크합니다(`SKILLS_DIR`로 다른 곳 지정). 그 자리에 진짜 폴더가 있으면 건드리지 않고 경고만 합니다.
- `~/.seori`(또는 `$SEORI_HOME`)를 권한 700으로 만듭니다.
- herdr, herdr의 omp 연동, omp, gh, PATH의 `seori`가 없으면 경고합니다.

herdr, omp, gh를 설치하지는 않습니다. `secrets.json`, `messengers.json`, `config.json`은 절대 만들거나 덮어쓰지 않습니다.

## 상태 저장 위치

모든 상태는 `~/.seori`(또는 `$SEORI_HOME`) 아래 JSON과 JSONL 파일입니다: `lanes/`, `inbox/`, `briefs/`, `receipts/`, 시간 단위 루프용 `backlog/`, `loop/`, 듀티 정지 파일과 자원 감시 상태(`duty/guard.json`), 멈춤 판단용 변경 기록(`duty/supervision.json`)이 있는 `duty/`, 리드 채널용 `lead/`(저장된 메신저 메시지, 리드에게 온 감시 알림, 그 기록), 데몬의 잠금 파일과 heartbeat, 메신저마다의 커서와 상태 파일(그리고 `fake` 메신저)용 `messenger/`, 감시와 그 기록용 `watches/`, 레인마다의 체크포인트 기록(`<key>.jsonl`)용 `checkpoints/`, 무거운 작업 자리 잠금(`<n>.lock`)용 `heavy/`, `lessons.jsonl`, `worklog.jsonl`과 거기서 만든 `worklog.md`, `config.json`, `messengers.json`, 그리고 `secrets.json`(권한 600). omp 세션 말고 계속 도는 프로세스는 듀티 루프, 시간 단위 루프, 데몬(그리고 명령 감시가 띄운 명령)뿐입니다. 실행에 필요한 건 Bun 하나입니다.

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
| `SEORI_TELEGRAM_TOKEN`, `SEORI_SLACK_BOT_TOKEN`, `SEORI_SLACK_APP_TOKEN`, `SEORI_DISCORD_TOKEN` | 메신저 토큰. `secrets.json`보다 먼저 |

## 테스트

```sh
bun test         # 가짜 herdr와 gh로 도는 단위 테스트. 모델을 부르지 않습니다
bun run typecheck
```

끝단 테스트 `test/e2e.test.ts`(레인과 시간 단위 루프), `test/e2e-channel.test.ts`(메신저 채널: 한가할 때, 바쁠 때, 몰아서, 리드 재시작, `/new`, 하위 에이전트, Esc, 모델 장애와 복구, 계속된 장애로 포기, 데몬 강제 종료와 설정 변경), `test/e2e-watch.test.ts`(감시: 명령 필터와 종료, 죽은 명령 다시 띄우기, 파일 변경, `/new`, 리드 재시작, 데몬 강제 종료, 깨우기 한도와 다시 켜기, 레인의 감시, 창 상태, 개수 제한, herdr가 꺼진 뒤 남은 명령 없음)는 진짜 herdr(omp 연동 설치), PATH의 omp, 그리고 `SEORI_E2E_OMP=1`이 필요합니다. 진짜 모델을 부르므로 비용이 들고, 조건이 없으면 건너뜁니다. 채널 테스트는 약 18분, 감시 테스트는 약 6분 걸립니다. `SEORI_E2E_ONLY=1,2,3`처럼 일부만 돌릴 수 있습니다(채널 8번 장애 시나리오만 약 9분).

## 텔레메트리

없습니다. seori는 어디에도 데이터를 보내지 않습니다.

## 원본과 다른 점

- 에이전트: 원본과 달리 omp를 씁니다. 기본 에이전트 명령은 `omp`입니다.
- 레인은 `herdr agent start --kind omp`로 켜고 `/goal`로 시작하므로, 모든 레인이 omp 목표 모드로 돕니다. 브리프에는 확인 가능한 끝나는 조건을 씁니다.
- herdr의 omp 연동이 꼭 필요합니다. 이게 있어야 herdr가 omp의 상태를 알 수 있습니다.
- 리뷰어는 저장소의 AGENTS.md, 스킬, 규칙, 확장에서 격리된 비대화형 omp입니다.
- 텔레메트리가 없습니다.
- 이름: 명령 `seori`, 상태 폴더 `~/.seori`, 환경 변수 `SEORI_*`.
- "다 했다"는 주장은 증거를 붙인 레인의 READY입니다. 따로 주장하는 명령은 없습니다. Done 줄이 있는 레인은 READY 뒤 `closeAfterMin`분이 지나고, 모든 신호가 실제로 맞고, 커밋이나 푸시 안 된 작업이 없을 때 seori가 닫습니다.
- `seori merge`는 리뷰 기록과 체크 다음에 verify-pr을 돌립니다. 커밋 신원과 "수정에는 테스트" 규칙이 머지 관문의 일부입니다.
- `repoIdentities` 항목이 없는 저장소는 커밋 신원 확인을 건너뛰고, 출력에 그렇게 적습니다. 실패로 보지 않습니다.
- 읽지 못한 컴퓨터 값(디스크, 창 수)으로는 레인을 막지도, 알리지도 않습니다.
- 주인은 `seori msg pair`로 등록합니다. 봇에게 다음에 DM을 보낸 사람이 주인이 됩니다.
- 슬랙은 Socket Mode 봇 앱으로만 씁니다. 사용자 토큰은 쓰지 않습니다.
- 음성, 접속 상태(presence), 리액션은 없습니다. 음성 메시지는 다른 파일처럼 첨부 파일 줄로 리드에게 갑니다.
- 원본의 Dori 모드 대신 서리 모드 스킬(`skills/seori-mode`)이 있습니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 보세요.
