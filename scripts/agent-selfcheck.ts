/** Offline selfchecks, in their original execution order. */
import { scanSection, taxonomySection, organizeSection } from './selfcheck/software.ts'
import { gameIdentifySection, saveBackupSection, saveDbSection, playSessionSection, engineRulesSection, linksAndCoverSection } from './selfcheck/game.ts'
import { videoDataSection, videoFilenameSection, videoScanSection, videoNfoSection, videoContainerSection, videoTmdbSection, videoFactsSection, videoDoubanSection, videoIdentifySection, videoPosterSection, videoUserEditedSection, videoPlaybackSection, hentaiCategorySection, hentaiFilenameSection, hanimeChannelSection, hideHentaiSection } from './selfcheck/video.ts'
import { agentSection, rendererUtilitiesSection, migrationSection, proxySection, portableSection } from './selfcheck/infra.ts'
import { report } from './selfcheck/shared.ts'

async function main(): Promise<void> {
  await scanSection()
  await agentSection()
  await taxonomySection()
  await rendererUtilitiesSection()
  await organizeSection()
  await migrationSection()
  await gameIdentifySection()
  await saveBackupSection()
  await saveDbSection()
  await playSessionSection()
  await engineRulesSection()
  await linksAndCoverSection()
  await videoDataSection()
  await videoFilenameSection()
  await videoScanSection()
  await videoNfoSection()
  await videoContainerSection()
  await videoTmdbSection()
  await videoFactsSection()
  await videoDoubanSection()
  await videoIdentifySection()
  await videoPosterSection()
  await videoUserEditedSection()
  await videoPlaybackSection()
  await hentaiCategorySection()
  await hentaiFilenameSection()
  await hanimeChannelSection()
  await proxySection()
  await portableSection()
  await hideHentaiSection()
  report()
}

void main()
