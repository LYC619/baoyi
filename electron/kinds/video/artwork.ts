export interface VideoArtwork { path: string; url: string; width: number; height: number }

/** URL roles are hints; decoded dimensions decide which image fits each surface. */
export function selectVideoArtwork(images: VideoArtwork[], posterUrl = '', thumbnailUrl = '') {
  const valid = images.filter(image => image.width >= 64 && image.height >= 64)
  const portraits = valid.filter(image => image.height > image.width * 1.05)
  const landscapes = valid.filter(image => image.width > image.height * 1.2)
  const poster = portraits.find(image => image.url === posterUrl) || portraits[0] || valid.find(image => image.url === posterUrl) || valid[0]
  const thumbnail = landscapes.find(image => image.url === thumbnailUrl) || landscapes[0] || valid.find(image => image.url === thumbnailUrl) || poster
  return { poster, thumbnail, hasPortrait: portraits.length > 0, hasLandscape: landscapes.length > 0 }
}
