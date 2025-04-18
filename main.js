const core = require('@actions/core')
const github = require('@actions/github')
const AdmZip = require('adm-zip')
const {filesize} = require('filesize')
const pathname = require('path')
const fs = require('fs')

function inform(key, val) {
    core.info(`==> ${key}: ${val}`)
}

async function main() {
    let nothrow = core.getInput("nothrow")
    let artifacts = []

    try {
        const token = core.getInput("github_token", { required: true })
        const workflow = core.getInput("workflow", { required: true })
        const [owner, repo] = core.getInput("repo", { required: true }).split("/")
        const path = core.getInput("path", { required: true })
        const name = core.getInput("name")
        const skipUnpack = core.getInput("skip_unpack")
        let workflowConclusion = core.getInput("workflow_conclusion")
        let pr = core.getInput("pr")
        let commit = core.getInput("commit")
        let branch = core.getInput("branch")
        let event = core.getInput("event")
        let runID = core.getInput("run_id")
        let runNumber = core.getInput("run_number")
        let checkArtifacts = core.getInput("check_artifacts")
        let searchArtifacts = core.getInput("search_artifacts")
        let searchDepth = core.getInput("search_depth")|0 || Number.POSITIVE_INFINITY
        let dryRun = core.getInput("dry_run")
        let filtered

        const client = github.getOctokit(token)

        core.info(`==> Artifact name: ${name}`)
        core.info(`==> Local path: ${path}`)
        core.info(`==> Workflow name: ${workflow}`)
        core.info(`==> Repository: ${owner}/${repo}`)
        core.info(`==> Workflow conclusion: ${workflowConclusion}`)

        const uniqueInputSets = [
            {
                "pr": pr,
                "commit": commit,
                "branch": branch,
                "run_id": runID
            }
        ]
        uniqueInputSets.forEach((inputSet) => {
            const inputs = Object.values(inputSet)
            const providedInputs = inputs.filter(input => input !== '')
            if (providedInputs.length > 1) {
                throw new Error(`The following inputs cannot be used together: ${Object.keys(inputSet).join(", ")}`)
            }
        })

        if (pr) {
            core.info(`==> PR: ${pr}`)
            const pull = await client.rest.pulls.get({
                owner: owner,
                repo: repo,
                pull_number: pr,
            })
            commit = pull.data.head.sha
            //branch = pull.data.head.ref
        }

        if (commit) {
            core.info(`==> Commit: ${commit}`)
        }

        if (branch) {
            branch = branch.replace(/^refs\/heads\//, "")
            core.info(`==> Branch: ${branch}`)
        }

        if (event) {
            core.info(`==> Event: ${event}`)
        }

        if (runNumber) {
            core.info(`==> Run number: ${runNumber}`)
        }

        if (!runID) {
            // Note that the runs are returned in most recent first order.
            for await (const runs of client.paginate.iterator(client.rest.actions.listWorkflowRuns, {
                owner: owner,
                repo: repo,
                workflow_id: workflow,
                ...(branch ? { branch } : {}),
                ...(event ? { event } : {}),
            }
            )) {
                for (const run of runs.data) {
                    if (searchDepth-- <= 0) {
                        break
                    }

                    if (commit && run.head_sha != commit) {
                        continue
                    }
                    if (runNumber && run.run_number != runNumber) {
                        continue
                    }
                    if (workflowConclusion && !['false', run.conclusion, run.status].includes(workflowConclusion)) {
                        continue
                    }
                    if (checkArtifacts || searchArtifacts) {
                        let artifacts = await client.rest.actions.listWorkflowRunArtifacts({
                            owner: owner,
                            repo: repo,
                            run_id: run.id,
                        })
                        if (artifacts.data.artifacts.length == 0) {
                            core.info(`==> No artifacts found for run ${run.id}`)
                            continue
                        }
                        if (searchArtifacts) {
                            const artifact = artifacts.data.artifacts.find((artifact) => {
                                return artifact.name == name
                            })
                            if (!artifact) {
                                continue
                            }
                        }
                    }
                    runID = run.id
                    core.info(`==> (found) Run ID: ${runID}`)
                    core.info(`==> (found) Run date: ${run.created_at}`)
                    break
                }
                if (runID || searchDepth <= 0) {
                    break
                }
            }
        }

        if (!runID) {
            throw new Error("no matching workflow run found with any artifacts?")
        }

        artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
            owner: owner,
            repo: repo,
            run_id: runID,
        })

        // One artifact or all if `name` input is not specified.
        if (name) {
            filtered = artifacts.filter((artifact) => {
                return artifact.name == name
            })
            if (filtered.length == 0) {
                core.info(`==> (not found) Artifact: ${name}`)
                core.info('==> Found the following artifacts instead:')
                for (const artifact of artifacts) {
                    core.info(`\t==> (found) Artifact: ${artifact.name}`)
                }
            }
            artifacts = filtered
        }

        if (dryRun) {
            if (artifacts.length == 0) {
                core.setOutput("dry_run", false)
                return
            } else {
                core.setOutput("dry_run", true)
                core.info('==> (found) Artifacts')
                for (const artifact of artifacts){
                    const size = filesize(artifact.size_in_bytes, { base: 10 })
                    core.info(`\t==> Artifact:`)
                    core.info(`\t==> ID: ${artifact.id}`)
                    core.info(`\t==> Name: ${artifact.name}`)
                    core.info(`\t==> Size: ${size}`)
                }
                return
            }
        }

        if (artifacts.length == 0) {
            throw new Error("no artifacts found")
        }

        for (const artifact of artifacts) {
            core.info(`==> Artifact: ${artifact.id}`)

            const size = filesize(artifact.size_in_bytes, { base: 10 })

            core.info(`==> Downloading: ${artifact.name}.zip (${size})`)

            const zip = await client.rest.actions.downloadArtifact({
                owner: owner,
                repo: repo,
                artifact_id: artifact.id,
                archive_format: "zip",
            })

            if (skipUnpack) {
                fs.mkdirSync(path, { recursive: true })
                fs.writeFileSync(`${pathname.join(path, artifact.name)}.zip`, Buffer.from(zip.data), 'binary')
                continue
            }

            const dir = name ? path : pathname.join(path, artifact.name)

            fs.mkdirSync(dir, { recursive: true })

            const adm = new AdmZip(Buffer.from(zip.data))

            core.startGroup(`==> Extracting: ${artifact.name}.zip`)
            adm.getEntries().forEach((entry) => {
                const action = entry.isDirectory ? "creating" : "inflating"
                const filepath = pathname.join(dir, entry.entryName)

                core.info(`  ${action}: ${filepath}`)
            })

            adm.extractAllTo(dir, true)
            core.endGroup()
        }

    } catch (error) {
        core.setOutput("error_message", error.message)
        if (nothrow) {
            core.info(`==> Error (nothrow): ${error.message}`)
        } else {
            core.setFailed(error.message)
        }
    } finally {
        core.setOutput('artifacts_length', artifacts.length)
        core.setOutput('artifact_hit', artifacts.length > 0)
    }
}

main()
