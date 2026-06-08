import fs from 'fs';
import path from 'path';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';
const OUTPUT_DIR = './public';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'map-style.json');

async function main() {
  try {
    console.log(`Fetching style from: ${STYLE_URL}...`);
    const res = await fetch(STYLE_URL);
    if (!res.ok) {
      throw new Error(`Failed to fetch style: ${res.statusText}`);
    }
    const style = await res.json();
    console.log('Successfully fetched style JSON. Transforming layers for decluttering...');

    // Filter out unwanted layers (road names and shields)
    style.layers = style.layers.filter(layer => {
      const id = layer.id || '';
      
      // Remove all road shields (A10, B5, etc.) and road name labels
      if (
        id.includes('shield') ||
        id.includes('road_shield') ||
        id.startsWith('highway-name-')
      ) {
        return false;
      }
      return true;
    });

    // Transform layer styling properties
    style.layers = style.layers.map(layer => {
      const id = layer.id || '';
      
      if (!layer.layout) layer.layout = {};
      if (!layer.paint) layer.paint = {};

      // 1. Background layer
      if (id === 'background') {
        layer.paint['background-color'] = '#fcfbf9'; // Warm soft background
      }

      // 2. Water layers
      else if (id.includes('water')) {
        if (layer.paint['fill-color'] !== undefined) {
          layer.paint['fill-color'] = '#C7EAFB'; // Sky-blue water
        }
        if (layer.paint['line-color'] !== undefined) {
          layer.paint['line-color'] = '#A2DAF5'; // Waterways slightly darker/outlined
        }
      }

      // 3. Forest / Park / Grass / Wood layers
      else if (
        id.includes('park') ||
        id.includes('forest') ||
        id.includes('grass') ||
        id.includes('wood') ||
        id.includes('cemetery')
      ) {
        if (layer.paint['fill-color'] !== undefined) {
          layer.paint['fill-color'] = '#E5F0D9'; // Saturated warm-green forest/grass
        }
        if (id === 'landcover-wood') {
          layer.paint['fill-opacity'] = 0.5;
        }
      }

      // 4. Landuse residential/suburb area declutter
      else if (id === 'landuse-residential' || id === 'landuse-suburb') {
        layer.minzoom = 12; // Only show built-up areas when zoomed in
      }

      // 5. Town, village, and other smaller labels declutter
      else if (id === 'label_village' || id === 'label_other') {
        layer.minzoom = 10.5; // Hide tiny villages at zoom 10, show from zoom 10.5
      }
      else if (id === 'label_town') {
        layer.minzoom = 8.0; // Show major regional towns (Nauen, Oranienburg) starting at zoom 8
      }
      else if (id.startsWith('poi_')) {
        layer.minzoom = 14; // Hide POIs at zoom 10
      }
      else if (id.startsWith('water_name_') || id === 'waterway_line_label') {
        layer.minzoom = 12; // Hide water body name labels at zoom 10
      }

      // 6. Roads (Highways, primary/secondary/tertiary/minor links)
      else if (
        (id.startsWith('highway-') || id.startsWith('tunnel-') || id.startsWith('bridge-')) &&
        !id.includes('railway') &&
        !id.includes('transit') &&
        !id.includes('path')
      ) {
        // Minor roads (residential, service, track)
        if (id.includes('-minor') || id.includes('service') || id.includes('track')) {
          layer.minzoom = 11.5; // Hide minor roads completely at zoom 10
          if (layer.paint['line-color'] !== undefined) {
            layer.paint['line-color'] = '#FFFFFF'; // Clean white when visible
          }
        }
        // Secondary/Tertiary roads
        else if (id.includes('-secondary-tertiary') || id.includes('link')) {
          layer.minzoom = 9.5; // Keep visible at zoom 10, hide at zoom 8/9
          if (layer.paint['line-color'] !== undefined) {
            layer.paint['line-color'] = '#E1E1DB';
          }
        }
        // Road casings (borders)
        else if (id.endsWith('-casing')) {
          if (layer.paint['line-color'] !== undefined) {
            layer.paint['line-color'] = '#D2D2CA';
          }
        }
        // Major fills
        else {
          if (layer.paint['line-color'] !== undefined) {
            layer.paint['line-color'] = '#E1E1DB';
          }
          if (layer.paint['fill-color'] !== undefined) {
            layer.paint['fill-color'] = '#E1E1DB';
          }
        }
      }

      return layer;
    });

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      console.log(`Creating output directory: ${OUTPUT_DIR}`);
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Write back modified style
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(style, null, 2), 'utf-8');
    console.log(`Successfully generated customized decluttered style at: ${OUTPUT_FILE}`);

  } catch (error) {
    console.error('Error generating map style:', error);
    process.exit(1);
  }
}

main();
