# 4. A PR's AI Usage line says who merges it: Foreman with automerge on, a person with it off

Every PR Foreman opens says who merges it. With automerge on at delivery, it says Foreman merges once its checks pass. Otherwise it says a person merges it. Rejected: one fixed line, which is false whenever automerge is on. A PR delivered before automerge was turned on keeps the old line until it's delivered again.
