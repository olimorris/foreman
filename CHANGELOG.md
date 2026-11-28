# Changelog

## [0.3.0](https://github.com/olimorris/foreman/compare/v0.2.0...v0.3.0) (2026-11-28)


### Features

* block merge, approve and force-push commands in the hook ([#89](https://github.com/olimorris/foreman/issues/89)) ([021c191](https://github.com/olimorris/foreman/commit/021c191f5598effd089f7e13484648fde16130a2))
* list protected paths in every brief ([#92](https://github.com/olimorris/foreman/issues/92)) ([69bc5d9](https://github.com/olimorris/foreman/commit/69bc5d9be0682f0b9d222e86ca5ed66f9bd15c72))
* never automerge a PR that touches protected paths ([#91](https://github.com/olimorris/foreman/issues/91)) ([6edc351](https://github.com/olimorris/foreman/commit/6edc3515673c88d73a274b97826902be7ae9dc52))
* only automerge PRs at or below a risk level ([#90](https://github.com/olimorris/foreman/issues/90)) ([e2dcce2](https://github.com/olimorris/foreman/commit/e2dcce22c4b6d21f99186e231aaac752e7e142ed))
* reset the plan's budget count with foreman budget reset ([#79](https://github.com/olimorris/foreman/issues/79)) ([daafa4c](https://github.com/olimorris/foreman/commit/daafa4c275e8b11adfc69d6531047dba0aad6892))
* show what's coming next in the status pane ([#83](https://github.com/olimorris/foreman/issues/83)) ([2dfdc1c](https://github.com/olimorris/foreman/commit/2dfdc1c1f6aae896aeb54f7885e6cc8f4009f974))


### Bug Fixes

* answer an already-running watch or together call without waking the orchestrator ([#84](https://github.com/olimorris/foreman/issues/84)) ([703e279](https://github.com/olimorris/foreman/commit/703e2792764f39916e0b8c59480a907bc32e22ab))
* hold automerge on a PR that has no checks ([#88](https://github.com/olimorris/foreman/issues/88)) ([bb59611](https://github.com/olimorris/foreman/commit/bb5961157ebbd3cf44ace233cefd488b343ad4ee))
* let the reviewer read the user's global skills ([#77](https://github.com/olimorris/foreman/issues/77)) ([27c9f0c](https://github.com/olimorris/foreman/commit/27c9f0c9ed0243aa0f05a4f99967577c82936b36))
* show the plan's own spend in status, the pane and the summary ([#80](https://github.com/olimorris/foreman/issues/80)) ([d17659f](https://github.com/olimorris/foreman/commit/d17659f6dd61651ce45f56c000992a7c3ce3eb6e))
* wake the orchestrator only for lines that need it, and fix sync for stacked tasks ([#82](https://github.com/olimorris/foreman/issues/82)) ([1ae060d](https://github.com/olimorris/foreman/commit/1ae060d2482bffae4a8c3384f774e7ef98b9f412))


### Reverts

* say what Foreman guarantees in the README ([#95](https://github.com/olimorris/foreman/issues/95)) ([804239a](https://github.com/olimorris/foreman/commit/804239ac1a8e5f2c4bed423ad1a5f9bf7fbb46bc))

## [0.2.0](https://github.com/olimorris/foreman/compare/v0.1.0...v0.2.0) (2026-11-25)


### Features

* add foreman timeline to show how a run went ([#22](https://github.com/olimorris/foreman/issues/22)) ([587c649](https://github.com/olimorris/foreman/commit/587c649bff3dd1026facf45356badb4cb1b06645))
* carry on the orchestrator's last conversation with foreman up ([#73](https://github.com/olimorris/foreman/issues/73)) ([e8749c4](https://github.com/olimorris/foreman/commit/e8749c45a320cab9c03f16a750494eca13e3c2f1))
* change how many workers run at once with foreman workers ([#40](https://github.com/olimorris/foreman/issues/40)) ([6d0d84f](https://github.com/olimorris/foreman/commit/6d0d84fd8377ea3a5350e443d74c574e7f7e54d5))
* check that the open PRs merge and pass tests together ([#21](https://github.com/olimorris/foreman/issues/21)) ([ba6d70a](https://github.com/olimorris/foreman/commit/ba6d70af120253ec3c22cdfa6762c11b8b689852))
* choose the model each task runs on ([#24](https://github.com/olimorris/foreman/issues/24)) ([c769437](https://github.com/olimorris/foreman/commit/c769437b2c06d5506c8462fdc2382d8f2301884a))
* choose the orchestrator's model ([#38](https://github.com/olimorris/foreman/issues/38)) ([9572e8b](https://github.com/olimorris/foreman/commit/9572e8b06db2504da7d91a01b73f059657552cbd))
* detect the terminal Foreman is running in ([#53](https://github.com/olimorris/foreman/issues/53)) ([0af587e](https://github.com/olimorris/foreman/commit/0af587e54ccc9403b9d82449e92ae4be1b1926cd))
* follow the user's own skills in .foreman/skills when reviewing and opening PRs ([#41](https://github.com/olimorris/foreman/issues/41)) ([ad266f8](https://github.com/olimorris/foreman/commit/ad266f89aa034f963b22a9ccd0564c98e1f61fa0))
* give the orchestrator Foreman's tools over MCP instead of the CLI ([#59](https://github.com/olimorris/foreman/issues/59)) ([79c09b5](https://github.com/olimorris/foreman/commit/79c09b5ae9e0027b8360d2fd79fc07c2b35877c2))
* give workers and the orchestrator the user's own skills ([#56](https://github.com/olimorris/foreman/issues/56)) ([566d8c3](https://github.com/olimorris/foreman/commit/566d8c3061e7b6263a3513c5118d1a59533e4167))
* give workers Foreman's tools over MCP instead of the CLI ([#58](https://github.com/olimorris/foreman/issues/58)) ([6ee4c6a](https://github.com/olimorris/foreman/commit/6ee4c6a4641b279cb964158aee86badad931f2c4))
* install Foreman with Homebrew ([#51](https://github.com/olimorris/foreman/issues/51)) ([0aa35e2](https://github.com/olimorris/foreman/commit/0aa35e2ca32a813aaf1f5669f274359e17d8b583))
* keep a list of things Foreman must never do ([#39](https://github.com/olimorris/foreman/issues/39)) ([df9ec35](https://github.com/olimorris/foreman/commit/df9ec354fe87ece718cb73113293f9e01b416e9c))
* keep only the commands people use in the CLI ([#67](https://github.com/olimorris/foreman/issues/67)) ([1334520](https://github.com/olimorris/foreman/commit/13345206a1468d54976eac745c003f53df1d5ea2))
* lay out foreman status and foreman budget by what needs you ([#15](https://github.com/olimorris/foreman/issues/15)) ([5d00303](https://github.com/olimorris/foreman/commit/5d0030359b3ee88669d8e1f709cf4fbf529c9479))
* let Foreman make its call when a question goes unanswered ([#23](https://github.com/olimorris/foreman/issues/23)) ([c9623c4](https://github.com/olimorris/foreman/commit/c9623c4c059451657014e4b231b8507b6e0dcbbd))
* let Foreman merge approved PRs when the user says so ([#42](https://github.com/olimorris/foreman/issues/42)) ([be03340](https://github.com/olimorris/foreman/commit/be0334069ab9f8548fc45ad331a78e11f15d4fc0))
* let the MCP server offer tools to each kind of session ([#57](https://github.com/olimorris/foreman/issues/57)) ([8d01b76](https://github.com/olimorris/foreman/commit/8d01b7692f74eab054034d299aa633a964d810f7))
* let the orchestrator wait on the watcher as an MCP task ([#60](https://github.com/olimorris/foreman/issues/60)) ([7c30914](https://github.com/olimorris/foreman/commit/7c309140fc21591d41bdfee404e8013412304666))
* let the plan tool take the plan's text so the orchestrator never writes plan.md ([#65](https://github.com/olimorris/foreman/issues/65)) ([5e5caf3](https://github.com/olimorris/foreman/commit/5e5caf35893f8b4f3a762e4e395a0f4f35045372))
* load the user's global skills from ~/.config/foreman/skills ([#76](https://github.com/olimorris/foreman/issues/76)) ([1376657](https://github.com/olimorris/foreman/commit/13766574470c4377ec9e3cf341db33af2b3845db))
* name worker and review tabs after their task ([#5](https://github.com/olimorris/foreman/issues/5)) ([0509a98](https://github.com/olimorris/foreman/commit/0509a98bf3849ab4c0459a48506c7590594ea166))
* number workers W1 to WN and link Rex in the README ([#13](https://github.com/olimorris/foreman/issues/13)) ([2a6bd54](https://github.com/olimorris/foreman/commit/2a6bd544a3cc896b4b9ed43fcb39e79ccbfef3f3))
* open a live status pane beside the orchestrator ([#17](https://github.com/olimorris/foreman/issues/17)) ([5f22703](https://github.com/olimorris/foreman/commit/5f22703a071e203097f08cdd94c6847dc22ee797))
* ping the user on Telegram when they allow it ([#44](https://github.com/olimorris/foreman/issues/44)) ([40f819b](https://github.com/olimorris/foreman/commit/40f819b58167d493e3be0b76c7bde3ab6c854b4b))
* print the installed version with foreman --version ([#52](https://github.com/olimorris/foreman/issues/52)) ([ca45878](https://github.com/olimorris/foreman/commit/ca4587827f0945017cdf5bcba9409be3076ba0ba))
* remove Foreman from a repo with foreman remove ([#69](https://github.com/olimorris/foreman/issues/69)) ([b7d89bc](https://github.com/olimorris/foreman/commit/b7d89bcde224c1bea7291c037390d17a27b52ce5))
* restart workers that hang ([#8](https://github.com/olimorris/foreman/issues/8)) ([19ece0a](https://github.com/olimorris/foreman/commit/19ece0a55316f511cf7c6d3d046d1b943d61923c))
* run Foreman in Ghostty ([#33](https://github.com/olimorris/foreman/issues/33)) ([abf25af](https://github.com/olimorris/foreman/commit/abf25afd09df2c28a6aaebd5b929c97857010608))
* run Foreman in Herdr ([#36](https://github.com/olimorris/foreman/issues/36)) ([d21a6bb](https://github.com/olimorris/foreman/commit/d21a6bbbc322a0fe1aeb6af3667451cfdb492026))
* run Foreman in Orca ([#32](https://github.com/olimorris/foreman/issues/32)) ([940b1d2](https://github.com/olimorris/foreman/commit/940b1d245dfd9e038e880be8464ae09a726653d0))
* run the watcher, baseline and together check as MCP tasks ([#61](https://github.com/olimorris/foreman/issues/61)) ([00cf34c](https://github.com/olimorris/foreman/commit/00cf34cab5e2fe9dda2def6e2e7e836951d7446d))
* share known problems with workers and test main before a plan starts ([#20](https://github.com/olimorris/foreman/issues/20)) ([48c1e6f](https://github.com/olimorris/foreman/commit/48c1e6f8b8be51c4fb110e20b5be3da47c0ab25a))
* show the Foreman banner in yellow ([#10](https://github.com/olimorris/foreman/issues/10)) ([0363116](https://github.com/olimorris/foreman/commit/03631165cca66eccfdd6c82e01ac9a2d6162c0bb))
* show the run summary in a pager and list the everyday commands ([#18](https://github.com/olimorris/foreman/issues/18)) ([80ac532](https://github.com/olimorris/foreman/commit/80ac532ba454ec7db60e8f43b264033bba83bafb))
* show what each task costs with foreman budget ([#9](https://github.com/olimorris/foreman/issues/9)) ([83f8d5b](https://github.com/olimorris/foreman/commit/83f8d5b9758178bc3ea233fa574cbf5ac92c2a63))
* start a dependent task on its dependency's approved PR ([#19](https://github.com/olimorris/foreman/issues/19)) ([5ce819d](https://github.com/olimorris/foreman/commit/5ce819d103467cdc8c3362b025ff827572c01465))
* stop workers that go over budget ([#7](https://github.com/olimorris/foreman/issues/7)) ([d2d295d](https://github.com/olimorris/foreman/commit/d2d295d1b0a3a3770488bbb7e1e12798c3e9beef))
* tell a hung worker from a busy one, and stop leftover processes ([#25](https://github.com/olimorris/foreman/issues/25)) ([e08b5b5](https://github.com/olimorris/foreman/commit/e08b5b595c62b1f821d0505553c92f4e572798b8))
* tell the user when a permission blocks a worker, the reviewer or the orchestrator ([#46](https://github.com/olimorris/foreman/issues/46)) ([20bd2cb](https://github.com/olimorris/foreman/commit/20bd2cb9668e8872705abec7329876d88aaf6421))
* tidy the help page and usage errors ([#11](https://github.com/olimorris/foreman/issues/11)) ([da7c788](https://github.com/olimorris/foreman/commit/da7c788ad780f79e0df76cf16f93349adeee2d5e))
* wait out usage limits instead of treating workers as hung ([#35](https://github.com/olimorris/foreman/issues/35)) ([d057f60](https://github.com/olimorris/foreman/commit/d057f600d9b95b4faf7a9380788bc51f60d75ef7))
* write a run summary of the PRs to review ([#2](https://github.com/olimorris/foreman/issues/2)) ([5bd4d23](https://github.com/olimorris/foreman/commit/5bd4d236ae11edc8f460f4eb5db430053a4de433))
* write ADRs by the user's adr skill in .foreman/skills ([#47](https://github.com/olimorris/foreman/issues/47)) ([0fdc4e6](https://github.com/olimorris/foreman/commit/0fdc4e65cef5867be029f5eabbc576b48ab4945c))


### Bug Fixes

* drop attribution from worker commits and PR descriptions ([#3](https://github.com/olimorris/foreman/issues/3)) ([320e5aa](https://github.com/olimorris/foreman/commit/320e5aae0d75026f9d8ac8817599ea7cfbc158b3))
* drop what the orchestrator's instructions kept from before the MCP move ([#70](https://github.com/olimorris/foreman/issues/70)) ([f78e8e1](https://github.com/olimorris/foreman/commit/f78e8e1426c0fb830403ab3294c5164a102c5fe9))
* find the current Rex session from REX_BLOCK when REX_SESSION isn't set ([#64](https://github.com/olimorris/foreman/issues/64)) ([3c74d90](https://github.com/olimorris/foreman/commit/3c74d90a0803bbf9d8f058fccde109061c95d951))
* keep automerge on when the user approves a changed plan ([#66](https://github.com/olimorris/foreman/issues/66)) ([38e929a](https://github.com/olimorris/foreman/commit/38e929a8e820a7ed646d92a4b1919149f4e2c357))
* let workers write throwaway files in the session scratchpad ([#50](https://github.com/olimorris/foreman/issues/50)) ([e7846ef](https://github.com/olimorris/foreman/commit/e7846eff392748b7bc8eb66abf820335121c43aa))
* name the tool instead of a foreman command in tool replies ([#72](https://github.com/olimorris/foreman/issues/72)) ([e3e4e01](https://github.com/olimorris/foreman/commit/e3e4e017d77b56155a31b4b7fab8b9bccddc10fe))
* stop the edit guard reading an angle bracket in a quoted argument as a redirect ([#55](https://github.com/olimorris/foreman/issues/55)) ([0594702](https://github.com/olimorris/foreman/commit/0594702db22465b8e3fc5b86545c5966d83827af))
* stop treating a task that rebased before its first commit as merged ([#16](https://github.com/olimorris/foreman/issues/16)) ([24a5796](https://github.com/olimorris/foreman/commit/24a579626ec0bfd531949a5eccaaad436d334528))
* teardown processes correctly ([b343ab7](https://github.com/olimorris/foreman/commit/b343ab7e2a958aca6a0f985e9d402c953d41c4a1))
