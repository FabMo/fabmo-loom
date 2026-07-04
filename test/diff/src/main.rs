/// Differential-test fixture generator.
///
/// Builds one synthetic ToolpathResult (3 serpentine passes, asymmetric Z so
/// axis mixups can't cancel out) and writes the terrain kernel's OWN three
/// exports — gcode, sbp, json — to out/. The Node side then lowers the json
/// through passesToMoves → movesToGcode/movesToSbp and asserts identical
/// motion semantics against the native posts.

use std::fs;
use terrain_carver_kernel::gcode::generate_gcode;
use terrain_carver_kernel::heightmap::Heightmap;
use terrain_carver_kernel::json_export::generate_json;
use terrain_carver_kernel::sbp::generate_sbp;
use terrain_carver_kernel::toolpath::{generate_toolpath, CarvingConfig, ToolpathResult};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("relief") {
        emit_relief();
        return;
    }
    let passes: Vec<Vec<[f32; 3]>> = vec![
        vec![
            [0.5, 0.5, -0.10],
            [2.0, 0.5, -0.15],
            [3.5, 0.5, -0.05],
            [5.0, 0.5, -0.20],
        ],
        vec![
            [5.0, 1.0, -0.18],
            [3.5, 1.0, -0.12],
            [2.0, 1.0, -0.22],
            [0.5, 1.0, -0.08],
        ],
        vec![[0.5, 1.5, -0.25], [5.0, 1.5, -0.10]],
    ];

    let mut points = Vec::new();
    let mut pass_starts = Vec::new();
    for pass in &passes {
        pass_starts.push((points.len() / 3) as u32);
        for p in pass {
            points.extend_from_slice(p);
        }
    }
    let point_count = (points.len() / 3) as u32;

    let result = ToolpathResult {
        points,
        pass_count: passes.len() as u32,
        point_count,
        pass_starts,
    };
    let config = CarvingConfig::default();

    fs::create_dir_all("out").unwrap();
    fs::write("out/native.gcode", generate_gcode(&result, &config)).unwrap();
    fs::write("out/native.sbp", generate_sbp(&result, &config)).unwrap();
    fs::write("out/toolpath.json", generate_json(&result, &config)).unwrap();
    println!(
        "wrote out/native.gcode, out/native.sbp, out/toolpath.json ({} passes, {} points)",
        result.pass_count, result.point_count
    );
}

/// "relief" mode: run the REAL kernel pipeline (heightmap → ballnose raster
/// toolpath → json) on a synthetic gaussian-bump terrain, for the
/// end-to-end composition demo. This is genuine terrain_carver output, just
/// fed procedurally instead of from a DEM image.
fn emit_relief() {
    let (w, h) = (128u32, 96u32);
    let mut pixels = vec![0u8; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            // Two gaussian peaks, so the relief is asymmetric.
            let fx = x as f32 / w as f32;
            let fy = y as f32 / h as f32;
            let g = |cx: f32, cy: f32, s: f32, a: f32| {
                a * (-((fx - cx).powi(2) + (fy - cy).powi(2)) / (2.0 * s * s)).exp()
            };
            let v = g(0.35, 0.45, 0.18, 1.0) + g(0.7, 0.6, 0.12, 0.7);
            pixels[(y * w + x) as usize] = (v.min(1.0) * 255.0) as u8;
        }
    }

    let mut heightmap = Heightmap::from_grayscale(&pixels, w, h);
    let config = CarvingConfig {
        bit_diameter: 0.25,
        stepover_pct: 0.4, // coarse for a small demo file
        min_z: -0.25,
        max_z: 0.0,
        feed_rate: 100.0,
        plunge_rate: 50.0,
        safe_z: 0.5,
        spindle_speed: 14000,
        work_width: 6.0,
        work_height: 4.0,
        border: 0.5,
        ..CarvingConfig::default()
    };
    heightmap.set_physical_dimensions(config.work_width, config.work_height);
    let result = generate_toolpath(&heightmap, &config);

    fs::create_dir_all("out").unwrap();
    fs::write("out/relief.json", generate_json(&result, &config)).unwrap();
    println!(
        "wrote out/relief.json ({} passes, {} points)",
        result.pass_count, result.point_count
    );
}
