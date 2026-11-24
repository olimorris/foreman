---
name: pull-request
description: Write the commit and pull request for a change to Foreman. Use when committing, opening a PR or rewriting a PR description in this repo.
---

# Pull requests in Foreman

1. **Commit** with a single line in conventional commit form: `<type>(<optional scope>): <what changed>`, such as `feat: write a run summary of the PRs to review`. That line is the whole commit message, with no body and no trailers, so `git commit -m "<line>"` is all it takes.
2. **Open the PR** with the commit line as its title and a description in three sections, written like the engineer who made the change:

```markdown
## Summary

<What this PR does, in a sentence or two, as behaviour someone using Foreman would notice.>

## Why

<The problem: what was wrong or missing, and who it affected.>

## How to test

<Numbered steps a person follows by hand to see the change working, each saying what to look for.>
```

The description is done when someone who hasn't opened the diff knows what changed, why, and how to see it for themselves.

## Writing it

- Each sentence tells the reader something they couldn't assume. The tests and typecheck passing is a given for any PR.
- Use the words someone using Foreman would use: orchestrator, worker, reviewer, task, brief, decision. The diff below the description shows the code, so the description talks about behaviour.
- Test steps name real commands and what appears on screen, such as "run `git log --format=%B foreman/<id>`. Each commit should be a single line."
- After How to test, add a sentence on what could go wrong after merging when there's something worth saying. Workers already running when it merges are a common case.
- Add a screenshot or pasted output only when it shows something the diff can't, such as a rendered PR packet or a run summary.
- The description ends with its last real sentence. AI attribution lines and Co-Authored-By trailers stay out of commits and PRs.

## Example

Title: `fix: drop attribution from worker commits and PR descriptions`

> ## Summary
>
> Turns off the `Co-Authored-By: Claude` trailer on workers' commits, tells workers to keep commit messages to one conventional line, and removes the "Built by Foreman task" footer from the PRs Foreman opens. The AI Usage section stays.
>
> ## Why
>
> Every commit a worker made carried a trailer crediting Claude, and every PR Foreman opened ended with a footer saying which task built it. The AI Usage section already covers disclosure, so both were noise in the repo's history and in PRs.
>
> ## How to test
>
> 1. Run `foreman up` in a repo with a GitHub remote and give it a small task.
> 2. When the worker reports done, run `git log --format=%B foreman/<id>`. Each commit should be a single line, with no Co-Authored-By trailer.
> 3. Once Foreman opens the PR, check that its description ends with the Risk section, with no footer after it.
>
> Workers already running when this merges keep the old settings until they're restarted.
