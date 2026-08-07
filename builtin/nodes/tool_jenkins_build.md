---
# Built-in node: durable Jenkins build
runtime: none
palette: hidden
description: |
  Trigger one Jenkins job and durably monitor it until completion.

  The node persists queue/build checkpoints and never keeps a process blocked while waiting.
  Scheduler re-enters the same node at `pollInterval`; an existing queueId/buildNumber is reused,
  so a resumed run does not trigger the job again. Jenkins FAILURE/ABORTED/TIMEOUT are business
  outcomes and continue to downstream notification nodes. Authentication, configuration, and
  repeated platform request errors fail the AgentFlow node.

  Credentials are read from environment configuration. `credentialRef: team-ci` selects
  `JENKINS_TEAM_CI_BASE_URL`, `JENKINS_TEAM_CI_USERNAME`, and `JENKINS_TEAM_CI_TOKEN`, falling
  back to the standard `JENKINS_BASE_URL`, `JENKINS_USERNAME`, and `JENKINS_TOKEN` variables.
displayName: Jenkins Build
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: job
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: parameters
    default: "{}"
    description: "Jenkins Job 参数 JSON object。"
    showOnNode: true
  - type: text
    name: credentialRef
    default: ""
    description: "Project Deployment 中配置的 Jenkins 凭证引用；不在 flow.yaml 中填写 token。"
    showOnNode: false
  - type: text
    name: pollInterval
    default: "30s"
    showOnNode: false
  - type: text
    name: timeout
    default: "2h"
    showOnNode: false
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: status
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: url
    default: ""
    required: true
    description: "优先返回安装包 URL；没有安装包时返回 Jenkins Build URL。"
    showOnNode: true
  - type: text
    name: qrUrl
    default: ""
    description: "解析到二维码时返回，否则为空。"
    showOnNode: true
---
Trigger Jenkins job `${job}` with `${parameters}`, wait durably, then output `${status}`, `${url}`, and optional `${qrUrl}`.
