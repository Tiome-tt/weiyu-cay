use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use std::io::{Read, Write};

const MAX_FILTERED_BYTES: u64 = 32 * 1024 * 1024;

// Preserve pixels, filtering, profiles and ancillary chunks; only recompress IDAT.
pub(super) fn optimize_png(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut chunks = Vec::new();
    let mut compressed = Vec::new();
    let mut offset = 8usize;
    while offset < bytes.len() {
        let header = bytes.get(offset..offset.checked_add(8)?)?;
        let length = u32::from_be_bytes(header[..4].try_into().ok()?) as usize;
        let end = offset.checked_add(length)?.checked_add(12)?;
        let chunk = bytes.get(offset..end)?;
        let kind = &header[4..8];
        let crc = u32::from_be_bytes(chunk[length + 8..].try_into().ok()?);
        if crc32fast::hash(&chunk[4..length + 8]) != crc {
            return None;
        }
        if matches!(kind, b"acTL" | b"fcTL" | b"fdAT") {
            return None;
        }
        // Unknown unsafe-to-copy chunks may depend on the exact compressed stream.
        if kind[3].is_ascii_uppercase()
            && !matches!(
                kind,
                b"IHDR"
                    | b"PLTE"
                    | b"IDAT"
                    | b"IEND"
                    | b"tRNS"
                    | b"gAMA"
                    | b"cHRM"
                    | b"sRGB"
                    | b"iCCP"
                    | b"sBIT"
                    | b"bKGD"
                    | b"pHYs"
                    | b"eXIf"
                    | b"hIST"
                    | b"sPLT"
                    | b"tIME"
                    | b"cICP"
                    | b"mDCv"
                    | b"cLLi"
            )
        {
            return None;
        }
        if kind == b"IDAT" {
            compressed.extend_from_slice(&chunk[8..length + 8]);
        }
        chunks.push(chunk);
        offset = end;
    }
    if compressed.is_empty() {
        return None;
    }
    let mut filtered = Vec::new();
    ZlibDecoder::new(compressed.as_slice())
        .take(MAX_FILTERED_BYTES + 1)
        .read_to_end(&mut filtered)
        .ok()?;
    if filtered.len() as u64 > MAX_FILTERED_BYTES {
        return None;
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(&filtered).ok()?;
    let data = encoder.finish().ok()?;
    let mut optimized = bytes[..8].to_vec();
    let mut inserted = false;
    for chunk in chunks {
        if &chunk[4..8] != b"IDAT" {
            optimized.extend_from_slice(chunk);
            continue;
        }
        if inserted {
            continue;
        }
        inserted = true;
        optimized.extend_from_slice(&(data.len() as u32).to_be_bytes());
        optimized.extend_from_slice(b"IDAT");
        optimized.extend_from_slice(&data);
        let mut hash = crc32fast::Hasher::new();
        hash.update(b"IDAT");
        hash.update(&data);
        optimized.extend_from_slice(&hash.finalize().to_be_bytes());
    }
    (optimized.len() < bytes.len()).then_some(optimized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{
        codecs::png::{CompressionType, FilterType, PngEncoder},
        ImageEncoder,
    };
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut result = (data.len() as u32).to_be_bytes().to_vec();
        result.extend_from_slice(kind);
        result.extend_from_slice(data);
        result.extend_from_slice(&crc32fast::hash(&result[4..]).to_be_bytes());
        result
    }
    fn png() -> Vec<u8> {
        let mut bytes = Vec::new();
        let pixels = vec![127; 256 * 256 * 4];
        PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::NoFilter)
            .write_image(&pixels, 256, 256, image::ExtendedColorType::Rgba8)
            .unwrap();
        bytes
    }
    #[test]
    fn lossless_recompression_retains_pixels_metadata_and_reduces_size() {
        let mut original = png();
        let metadata = chunk(b"tEXt", b"Author\0Cay");
        original.splice(33..33, metadata.clone());
        let optimized = optimize_png(&original).expect("poorly compressed PNG should shrink");
        assert!(optimized.len() < original.len());
        assert_eq!(
            image::load_from_memory(&original).unwrap().to_rgba8(),
            image::load_from_memory(&optimized).unwrap().to_rgba8()
        );
        assert!(optimized
            .windows(metadata.len())
            .any(|value| value == metadata));
        assert!(optimize_png(&optimized).is_none());
    }
    #[test]
    fn preserves_animation_unknown_chunks_and_invalid_input() {
        let mut animated = png();
        animated.splice(33..33, chunk(b"acTL", &[0; 8]));
        assert!(optimize_png(&animated).is_none());
        let mut unknown = png();
        unknown.splice(33..33, chunk(b"aaAA", &[1]));
        assert!(optimize_png(&unknown).is_none());
        assert!(optimize_png(b"invalid").is_none());
        let mut broken = png();
        broken[40] ^= 1;
        assert!(optimize_png(&broken).is_none());
    }
}
