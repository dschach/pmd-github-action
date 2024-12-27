import { ExecOutput } from '@actions/exec'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { Context as github_context } from '@actions/github/lib/context'
import * as github_utils from '@actions/github/lib/utils'
import * as tc from '@actions/tool-cache'
import * as exec from '@actions/exec'
import * as semver from 'semver'
import { promises as fs } from 'fs'
import * as path from 'path'
import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest'
import * as helper from './util_helper'

// Load at most MAX_PAGE pages when determining modified files.
// This is used both for pull/{pull_number}/files as well as for
// repos/compareCommits API calls.
const MAX_PAGE = 10

interface PmdInfo {
  version: string
  path: string
}

async function downloadPmdRelease(
  version: string,
  token: string
): Promise<PmdInfo> {
  let pmdVersion = version
  let cachedPmdPath = tc.find('pmd', version)
  core.debug(`cached path result: ${cachedPmdPath}`)
  if (cachedPmdPath === '') {
    const pmdRelease = await determinePmdRelease(version, token)
    pmdVersion = getPmdVersionFromRelease(pmdRelease)
    const pathToZipDistribution = await tc.downloadTool(
      getDownloadURL(pmdRelease)
    )
    const pmdExtractedFolder = await tc.extractZip(pathToZipDistribution)
    cachedPmdPath = await tc.cacheDir(pmdExtractedFolder, 'pmd', pmdVersion)
  }

  core.info(`Using PMD ${pmdVersion} from cached path ${cachedPmdPath}`)
  return {
    version: pmdVersion,
    path: path.join(cachedPmdPath, `pmd-bin-${pmdVersion}`)
  }
}

async function downloadPmdUrl(
  version: string,
  downloadUrl: string
): Promise<PmdInfo> {
  const pmdVersion = version
  const pathToZipDistribution = await tc.downloadTool(downloadUrl)
  const pmdExtractedFolder = await tc.extractZip(pathToZipDistribution)
  core.info(
    `Downloaded PMD ${pmdVersion} from ${downloadUrl} to ${pmdExtractedFolder}`
  )
  const files = await fs.readdir(pmdExtractedFolder)
  core.debug(`ZIP archive content: ${files}`)
  const subpath = files[0]
  core.debug(`Using the first entry as basepath for PMD: ${subpath}`)
  return {
    version: pmdVersion,
    path: path.join(pmdExtractedFolder, subpath)
  }
}

async function downloadPmd(
  version: string,
  token: string,
  downloadUrl: string | undefined
): Promise<PmdInfo> {
  if (version === 'latest' && downloadUrl !== undefined && downloadUrl !== '')
    throw new Error(
      `Can't combine version=${version} with custom downloadUrl=${downloadUrl}`
    )

  if (downloadUrl === undefined || downloadUrl === '') {
    return downloadPmdRelease(version, token)
  } else {
    return downloadPmdUrl(version, downloadUrl)
  }
}

async function executePmd(
  pmdInfo: PmdInfo,
  fileListOrSourcePath: string | string[],
  ruleset: string,
  reportFormat: string,
  reportFile: string,
  minimumPriority: string
): Promise<ExecOutput> {
  let pmdExecutable = '/bin/run.sh pmd'
  if (isPmd7Cli(pmdInfo.version)) {
    pmdExecutable = '/bin/pmd'
  }
  if (helper.getPlatform() === 'win32') {
    pmdExecutable = '\\bin\\pmd.bat'
  }

  if (isPmd7Cli(pmdInfo.version)) {
    pmdExecutable += ' check --no-progress'
  }

  let sourceParameter: string[]
  if (Array.isArray(fileListOrSourcePath)) {
    await writeFileList(fileListOrSourcePath)
    sourceParameter = [
      useNewArgsFormat(pmdInfo.version) ? '--file-list' : '-filelist',
      'pmd.filelist'
    ]
    core.info(
      `Running PMD ${pmdInfo.version} on ${fileListOrSourcePath.length} modified files...`
    )
  } else {
    sourceParameter = ['-d', fileListOrSourcePath]
    core.info(
      `Running PMD ${pmdInfo.version} on all files in path ${fileListOrSourcePath}...`
    )
  }

  const execOutput = await exec.getExecOutput(
    `${pmdInfo.path}${pmdExecutable}`,
    [
      useNewArgsFormat(pmdInfo.version) ? '--no-cache' : '-no-cache',
      ...sourceParameter,
      '-f',
      reportFormat,
      '-R',
      ruleset,
      '-r',
      reportFile,
      '--minimum-priority',
      minimumPriority
    ],
    {
      ignoreReturnCode: true
    }
  )
  core.debug(`stdout: ${execOutput.stdout}`)
  core.debug(`stderr: ${execOutput.stderr}`)
  core.debug(`exitCode: ${execOutput.exitCode}`)
  return execOutput
}

function useNewArgsFormat(pmdVersion: string): boolean {
  return semver.gte(pmdVersion, '6.41.0')
}

function isPmd7Cli(pmdVersion: string): boolean {
  return semver.major(pmdVersion) >= 7
}

type GitHubRestRelease =
  RestEndpointMethodTypes['repos']['getLatestRelease']['response']

async function determinePmdRelease(
  pmdVersion: string,
  token: string
): Promise<GitHubRestRelease> {
  core.debug(`determine release info for ${pmdVersion}`)

  const PUBLIC_GITHUB_API_URL = 'https://api.github.com'
  // the configured GitHubToken can only be used for the public GitHub instance.
  // If the action is used on a on-premise GHES instance, then the given token is
  // not valid for the public instance.
  const canUseToken = github_utils.defaults.baseUrl === PUBLIC_GITHUB_API_URL

  let octokit
  if (canUseToken) {
    core.debug(
      `Using token to access repos/pmd/pmd/releases/latest on ${github_utils.defaults.baseUrl}`
    )
    // only use authenticated token, if on public github and not on a custom GHES instance
    octokit = new github_utils.GitHub({ auth: token })
  } else {
    core.debug(
      `Not using token to access repos/pmd/pmd/releases/latest on ${PUBLIC_GITHUB_API_URL}, as token is for ${github_utils.defaults.baseUrl}`
    )
    // explicitly overwrite base url to be public github api, as pmd/pmd is only available there
    // not using the token, as that would only be valid for GHES
    octokit = new github_utils.GitHub({ baseUrl: PUBLIC_GITHUB_API_URL })
  }

  if (process.env['JEST_WORKER_ID']) {
    core.debug(
      'Detected unit test - directly using Octokit without proxy configuration'
    )
    // during unit test, we use Octokit directly. This uses then fetch to do the requests,
    // which can be mocked with fetch-mock(-jest). The octokit instance retrieved via @actions/github
    // uses under the hood undici, which uses a raw socket (node:tls), which can neither be mocked
    // by nock nor by fetch-mock.
    // Using @actions/github to get the octokit instance would also make sure, that the proxy configuration
    // is respected - which is ignored now in unit tests.
    if (canUseToken) {
      octokit = new Octokit({ baseUrl: PUBLIC_GITHUB_API_URL, auth: token })
    } else {
      octokit = new Octokit({ baseUrl: PUBLIC_GITHUB_API_URL })
    }
  }

  let release
  if (pmdVersion === 'latest') {
    release = await octokit.rest.repos.getLatestRelease({
      owner: 'pmd',
      repo: 'pmd'
    })
  } else {
    release = await octokit.rest.repos.getReleaseByTag({
      owner: 'pmd',
      repo: 'pmd',
      tag: `pmd_releases/${pmdVersion}`
    })
  }
  core.debug(`found release: ${release.data.name}`)
  return release
}

function getPmdVersionFromRelease(release: GitHubRestRelease): string {
  return release.data.tag_name.replace('pmd_releases/', '')
}

function getDownloadURL(release: GitHubRestRelease): string {
  const asset = release.data.assets.filter(a => {
    const version = getPmdVersionFromRelease(release)
    return (
      a.name === `pmd-bin-${version}.zip` ||
      a.name === `pmd-dist-${version}-bin.zip`
    )
  })[0]
  core.debug(`url: ${asset.browser_download_url}`)
  return asset.browser_download_url
}

async function writeFileList(fileList: string[]): Promise<void> {
  await fs.writeFile(path.join('.', 'pmd.filelist'), fileList.join(','), 'utf8')
}

type GitHubRestPullListFiles =
  RestEndpointMethodTypes['pulls']['listFiles']['response']
type GitHubRestCompareCommitsWithBasehead =
  RestEndpointMethodTypes['repos']['compareCommitsWithBasehead']['response']
type GitHubRestDiffEntry = GitHubRestPullListFiles['data'] extends (infer U)[]
  ? U
  : never

async function determineModifiedFiles(
  token: string,
  sourcePath: string
): Promise<string[] | undefined> {
  // creating new context instead of using "github.context" to reinitialize for unit testing
  const context = new github_context()
  const eventData = context.payload
  let octokit = github.getOctokit(token)
  if (process.env['JEST_WORKER_ID']) {
    core.debug(
      'Detected unit test - directly using Octokit without proxy configuration'
    )
    // during unit test, we use Octokit directly. This uses then fetch to do the requests,
    // which can be mocked with fetch-mock(-jest). The octokit instance retrieved via @actions/github
    // uses under the hood undici, which uses a raw socket (node:tls), which can neither be mocked
    // by nock nor by fetch-mock.
    // Using @actions/github to get the octokit instance would also make sure, that the proxy configuration
    // is respected - which is ignored now in unit tests.
    octokit = new Octokit({
      baseUrl: github_utils.defaults.baseUrl,
      auth: token
    })
  }

  if (context.eventName === 'pull_request') {
    core.debug(
      `Pull request ${eventData.number}: ${eventData.pull_request?.html_url}`
    )

    const modifiedFilenames = new Set<string>()

    // maximum of 300 files are loaded (page size is 30, max 10 pages)
    let page
    for (page = 1; page <= MAX_PAGE; page++) {
      const listFilesResponse: GitHubRestPullListFiles =
        await octokit.rest.pulls.listFiles({
          ...context.repo,
          pull_number: eventData.number,
          per_page: 30,
          page
        })
      const allFiles = listFilesResponse.data
      if (allFiles.length === 0) {
        break
      }
      const filenames = extractFilenames(allFiles, page, sourcePath)
      for (const f of filenames) {
        modifiedFilenames.add(f)
      }
    }
    if (page >= MAX_PAGE) {
      core.warning(
        `The pull request ${eventData.number} is too big - not all changed files will be analyzed!`
      )
    }

    return [...modifiedFilenames]
  } else if (context.eventName === 'push') {
    core.debug(
      `Push on ${eventData.ref}: ${eventData.before}...${eventData.after}`
    )

    const modifiedFilenames = new Set<string>()

    // maximum of 300 files are loaded (page size is 30, max 10 pages)
    let page
    for (page = 1; page <= MAX_PAGE; page++) {
      const compareResponse: GitHubRestCompareCommitsWithBasehead =
        await octokit.rest.repos.compareCommitsWithBasehead({
          ...context.repo,
          basehead: `${eventData.before}...${eventData.after}`,
          per_page: 30,
          page
        })
      const allFiles = compareResponse.data.files
      if (allFiles === undefined || allFiles.length === 0) {
        break
      }
      const filenames = extractFilenames(allFiles, page, sourcePath)
      for (const f of filenames) {
        modifiedFilenames.add(f)
      }
    }
    if (page >= MAX_PAGE) {
      core.warning(
        `The push on ${eventData.ref} is too big - not all changed files will be analyzed!`
      )
    }

    return [...modifiedFilenames]
  } else {
    core.warning(
      `Unsupported github action event '${context.eventName}' - cannot determine modified files. All files will be analyzed.`
    )
    return undefined
  }
}

function extractFilenames(
  allFiles: GitHubRestDiffEntry[],
  page: number,
  sourcePath: string
): string[] {
  core.debug(` got ${allFiles.length} entries from page ${page} to check...`)
  if (core.isDebug()) {
    // output can be enabled by adding repository secret "ACTIONS_STEP_DEBUG" with value "true".
    for (let i = 0; i < allFiles.length; i++) {
      core.debug(`   ${i}: ${allFiles[i].status} ${allFiles[i].filename}`)
    }
  }
  // add trailing slash
  sourcePath =
    sourcePath !== '.' ? path.normalize(`${sourcePath}/`) : sourcePath
  const filenames = allFiles
    .filter(
      f =>
        f.status === 'added' ||
        f.status === 'changed' ||
        f.status === 'modified'
    )
    .map(f => path.normalize(f.filename))
    .filter(f => sourcePath === '.' || f.startsWith(sourcePath))
  if (core.isDebug()) {
    core.debug(
      `   after filtering by status and with '${sourcePath}' ${filenames.length} files remain:`
    )
    core.debug(`   ${filenames.join(', ')}`)
  }
  return filenames
}

export { downloadPmd, executePmd, determineModifiedFiles }
