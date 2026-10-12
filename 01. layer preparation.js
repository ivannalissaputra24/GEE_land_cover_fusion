/**
 * ============================================================================
 * VOTER & OVERRIDE PREPARATION FOR MAJORITY VOTING
 * ============================================================================
 * Main Dataset : JRC Tropical Moist Forests (TMF)
 * Purpose      : Construct a multi-band image combining independent land cover 
 *                "voters" (forest vs. non-forest classifications) and absolute 
 *                "override" layers (built-up settlements).
 * 
 * Target Harmonized Encoding across all bands:
 *    1 = Forest     : Dataset explicitly identifies the pixel as forest.
 *    2 = Non-forest : Dataset explicitly identifies the pixel as non-forest.
 *    0 = Abstain    : Dataset lacks coverage, is outside target class, or no-data.
 * ============================================================================
 */
// Define the version string for the export asset name
var verExport = "v6";
// Notes for version export tracking documentation
var notes = "Add MBI layer; revised GFC to 30%TH";
// Define the asset ID path for the Kapuas Hulu Area of Interest (AOI) shapefile
var AOI_ASSET = '';
// Load the AOI FeatureCollection and apply a 120-meter buffer to all features to ensure edge coverage
var AOI = ee.FeatureCollection(AOI_ASSET).map(function(a) {
  return a.buffer(120);
});
// Extract the dissolved geometry from the AOI FeatureCollection for spatial filtering
var AOI_GEOM = AOI.geometry();
// Define target reference year for temporal matching across dynamic datasets
var BASE_YEAR = 2015;
// ==========================================================================
// 0. DATASET REGISTER
// ==========================================================================
// Load the JRC TMF Annual Changes image collection
var JRC_TMF_COLL = ee.ImageCollection('projects/JRC/TMF/v1_2025/AnnualChanges');
// Load the GLAD LCLUC image for the target BASE_YEAR
var GLCLU2020 = ee.Image('projects/glad/GLCLU2020/v2/LCLUC_' + BASE_YEAR);
// Load the Hansen GFC v1.13 dataset configuration parameters
var treeCovTh = 30; // Selected tree cover percentage threshold
var hansen_gfc = ee.Image('UMD/hansen/global_forest_change_2025_v1_13');
// Load the GLANCE Image Collection for land cover mapping
var GLANCE = ee.ImageCollection('projects/GLANCE/DATASETS/V001');
// Load the PALSAR FNF image collection for radar-based forest/non-forest extent
var PALSAR2_FNF = ee.ImageCollection("JAXA/ALOS/PALSAR/YEARLY/FNF");
// Load Potapov's Global Cropland extent for the specific BASE_YEAR
var GC_2015 = ee.ImageCollection('users/potapovpeter/Global_cropland_' + BASE_YEAR);
// Load the GFSAD GCEP30 image collection for cropland extent mapping
var GCEP2015 = ee.ImageCollection('projects/sat-io/open-datasets/GFSAD/GCEP30');
// Load the static MOEF 2016 dataset from user assets for national land cover benchmarking
var MOEF2016 = ee.Image('users/saputraivannalis24/modified_jrc_tmf/klh_2016');
// Load the Mapbiomas Indonesia dataset Collection 4
var MBI = ee.Image('projects/mapbiomas-public/assets/indonesia/lulc/collection4/mapbiomas_indonesia_collection4_coverage_v2');
// Load the Global Oil Palm planting year dataset collection
var GoP = ee.ImageCollection('projects/ee-globaloilpalm/assets/shared/GlobalOilPalm_YoP_2021');
// Load the IIASA mining vector features polygon collection
var mines = ee.FeatureCollection('projects/wri-datalab/SBTN/IIASA_mining_polygons');
// Load the GHSL 2018 built-up settlement dataset
var GHSL_built_raw = ee.Image('JRC/GHSL/P2023A/GHS_BUILT_C/2018');
// ==========================================================================
// 1. ANCHOR PROJECTION SETUP (JRC-TMF REFERENCE GRID)
// ==========================================================================
// Filter JRC TMF collection strictly for the ASIA regional mosaic domain
JRC_TMF_COLL = JRC_TMF_COLL.filter(ee.Filter.eq("system:index", "ASIA"));
// Extract native projection (CRS and transform) from the first image's first band
var tmfProj = JRC_TMF_COLL.first().select(0).projection();
// Print nominal scale (resolution in meters) to console to verify target grid scale (~30m)
print('TMF Anchor Projection Nominal Scale (m):', tmfProj.nominalScale());
// ==========================================================================
// 2. VOTER LAYER PROCESSING (Standardizing into 0/1/2 Scheme)
// ==========================================================================
// --- GLCLU (GLAD Global Land Cover & Land Use) ---
// Function to standardize GLCLU classes into Forest (1), Non-Forest (2), and Abstain (0)
function GLCLU2020Processing(img) {
  var forestValues = ee.List.sequence(27, 48).cat(ee.List.sequence(127, 148));
  var nonForestValues = ee.List.sequence(0, 26)
    .cat(ee.List.sequence(100, 126))
    .cat(ee.List.sequence(200, 207))
    .cat([241, 244, 250, 251, 254]);
  var noDataValues = [255];
  var fromValues = forestValues.cat(nonForestValues).cat(noDataValues);
  var toValues = ee.List.repeat(1, forestValues.length())
    .cat(ee.List.repeat(2, nonForestValues.length()))
    .cat([0]); 
  return img.remap(fromValues, toValues, 0).rename('voter_glclu');
}
// --- Hansen Global Forest Change (UMD GFC) ---
// Function to derive forest extent at BASE_YEAR using treecover2000 and lossyear metadata
function hansen_gfcProcessing(img, treeCoverPercent, BASE_YEAR) {
  var mask = img.select("treecover2000").gte(treeCoverPercent).remap([1, 0], [1, 2]);
  var lossYear = img.select("lossyear");
  var lossYearMasked = lossYear.gte(1).and(lossYear.lte(BASE_YEAR - 2000));
  return ee.Image(0)
        .where(mask.eq(1), 1)
        .where(mask.eq(2), 2)
        .where(lossYearMasked.eq(1), 2)
        .rename('voter_hansen');
}
// --- GLANCE Land Cover (BU / USGS) ---
// Function to extract and reclassify GLANCE land cover for BASE_YEAR
function GLANCEProcessing(imgColl, BASE_YEAR, bound) {
  var start = ee.Date.fromYMD(BASE_YEAR, 1, 1);
  var col = imgColl
    .filterBounds(bound)
    .filterDate(start, start.advance(1, 'year'))
    .select('LC');
  var lc = col.mosaic().remap([1, 2, 3, 4, 5, 6, 7], [2, 2, 2, 2, 1, 2, 2], 0);
  return lc.unmask(0).rename('voter_glance');
}
// --- JAXA ALOS/PALSAR Forest/Non-Forest (FNF) ---
// Function to process and reclassify PALSAR synthetic aperture radar FNF data
function PALSARProcessing(imgColl, BASE_YEAR) {
  var img = imgColl
    .filterDate(BASE_YEAR + '-01-01', BASE_YEAR + '-12-31')
    .select("fnf")
    .mosaic();
  return img.remap([1, 2, 3], [1, 2, 2], 0).unmask(0).rename('voter_palsar');
}
// --- Global Cropland Extent (Potapov et al.) ---
// Function to reclassify cropland presence indicators as Non-Forest (2)
function GCProcessing(imgColl, bound) {
  var img = imgColl.filterBounds(bound).mosaic();
  return img.remap([0, 1], [0, 2], 0).unmask(0).rename('voter_gc');
}
// --- GCEP30 (GFSAD 30m Global Cropland Extent) ---
// Function to reclassify GCEP cropland and water classes into standardized scheme
function GCEP30Processing(imgColl, bound) {
  var img = imgColl.filterBounds(bound).mosaic();
  return img.remap([0, 1, 2], [2, 0, 2], 0).unmask(0).rename('voter_gcep');
}
// --- MOEF / KLHK Land Cover 2016 ---
// Function to standardize Indonesian Ministry of Environment and Forestry land cover classes
function MOEF2016Processing(img) {
  return img.remap([1, 2, 3, 4, 5, 6], [1, 2, 2, 2, 2, 2], 0).unmask(0).rename('voter_moef');
}
// --- MapBiomas Indonesia (MBI) Collection 4 ---
// Function to standardize MapBiomas land cover classes for BASE_YEAR
function MBI15Processing(img) {
  var lc = img.select("classification_" + BASE_YEAR);
  return lc.remap(
    [3, 5, 76, 13, 40, 35, 9, 21, 30, 24, 25, 31, 33], 
    [1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], 0
  ).unmask(0).rename('voter_mbi');
}
// --- Global Oil Palm (Year of Planting Dataset) ---
// Filter Oil Palm dataset spatially by AOI and mosaic minimal NBR date band
var yop = GoP.filterBounds(AOI_GEOM).mosaic().select(['minNBR_date']);
// Convert raw pixel day count values into standard calendar years
var yopYear = yop.divide(365).add(1970);
// Flag agricultural areas planted on or before BASE_YEAR as Non-Forest (2)
var planted2015 = ee.Image(0)
  .where(yopYear.gte(1980).and(yopYear.lte(BASE_YEAR)), 2)
  .unmask(0)                   
  .rename('voter_oilpalm');
// --- Industrial Mining Extent (IIASA Mining Polygons) ---
// Filter vector mining polygons spatially by AOI boundary
var filteredMines = mines.filterBounds(AOI_GEOM); 
// Rasterize vector mining polygons into non-forest (2) pixels over an empty byte background image
var mineImg = ee.Image().byte().paint(filteredMines, 2).unmask(0).rename('voter_mining');
// ==========================================================================
// 3. OVERRIDE LAYERS (SETTLEMENT) + RESAMPLING
// ==========================================================================
// Extract built-up characteristics class range (11 to 25) representing urban settlements
var bc = GHSL_built_raw.select('built_characteristics');
var GHSL_built_reclass = bc.gte(11).and(bc.lte(25)).remap([0, 1], [0, 2], 0);
// Resample high-resolution 10m GHSL data to standard 30m target grid using mode reducer for categorical fidelity
var GHSL_built = GHSL_built_reclass
  .reduceResolution({
    reducer: ee.Reducer.mode(), // Assign predominant sub-pixel class category to 30m output cell
    maxPixels: 1024             // Set maximum sub-pixels limit evaluated per 30m grid unit
  })
  .reproject({ crs: tmfProj })  // Force output spatial grid alignment directly to anchor projection
  .unmask(0)                    // Replace unmapped or null background pixels with abstain value (0)
  .rename('override_ghsl');     // Set standardized output raster band name
// ==========================================================================
// 4. EXECUTION & MULTI-BAND BUNDLING
// ==========================================================================
// Execute individual processing functions across all independent input datasets
var reclass_GLCLU2020 = GLCLU2020Processing(GLCLU2020);
var reclass_HNS_GFC   = hansen_gfcProcessing(hansen_gfc, treeCovTh, BASE_YEAR); 
var reclass_GLANCE    = GLANCEProcessing(GLANCE, BASE_YEAR, AOI_GEOM);
var reclass_PALSAR    = PALSARProcessing(PALSAR2_FNF, BASE_YEAR);
var reclass_GC        = GCProcessing(GC_2015, AOI_GEOM);
var reclass_GCEP2015  = GCEP30Processing(GCEP2015, AOI_GEOM);
var reclass_MOEF2016  = MOEF2016Processing(MOEF2016);
var reclass_MBI2015   = MBI15Processing(MBI);
// Concatenate all individual voter and override layers into a single multi-band Image stack
var votersAndOverrides = ee.Image.cat([
  reclass_GLCLU2020,    
  reclass_HNS_GFC,      
  reclass_GLANCE,       
  reclass_PALSAR,       
  reclass_GC,           
  reclass_GCEP2015,     
  reclass_MOEF2016,
  reclass_MBI2015,
  planted2015,          
  mineImg,              
  GHSL_built            
]).toByte().clip(AOI_GEOM) // Cast image values to Byte data type (0-255) and clip strictly to AOI geometry
  .set({version: verExport, verNotes: notes}); // Assign version tracking and documentation metadata properties
// ==========================================================================
// 5. INTERACTIVE MAP VISUALIZATION
// ==========================================================================
// Center interactive map view over AOI feature bounds at zoom level 9
Map.centerObject(AOI, 9);
// Visualization parameters for individual voter layers: 0 = Black (Abstain), 1 = Dark Green (Forest), 2 = Yellow (Non-forest)
var visVoter = {min: 0, max: 2, palette: ['000000', '006400', 'FFFF00']};
// Add individual voter layers to the map canvas (hidden by default for cleaner UI performance)
Map.addLayer(reclass_GLCLU2020, visVoter, 'Voter: GLCLU2020', false);
Map.addLayer(reclass_HNS_GFC, visVoter, 'Voter: Hansen GFC', false);
Map.addLayer(reclass_GLANCE, visVoter, 'Voter: GLANCE', false);
Map.addLayer(reclass_PALSAR, visVoter, 'Voter: PALSAR FNF', false);
Map.addLayer(reclass_GC, visVoter, 'Voter: Global Cropland', false);
Map.addLayer(reclass_GCEP2015, visVoter, 'Voter: GCEP30', false);
Map.addLayer(reclass_MOEF2016, visVoter, 'Voter: MOEF 2016', false);
Map.addLayer(reclass_MBI2015, visVoter, 'Voter: MapBiomas ID 2015', false);
Map.addLayer(planted2015, visVoter, 'Voter: Oil Palm', false);
Map.addLayer(mineImg, visVoter, 'Voter: Mining', false);
// Add GHSL settlement override layer with transparent 0 values to highlight built-up urban areas in red
Map.addLayer(GHSL_built.selfMask(), {palette: ['FF0000']}, 'Override: GHSL Settlement', false);
// Create transparent boundary styling with distinct outline for the AOI polygon
var outlinedAoi = AOI.style({
  color: "570000",
  fillColor: "00000000", 
  width: 2
});
// Add AOI boundary vector overlay to map view
Map.addLayer(outlinedAoi, {color: 'white'}, 'Kapuas Hulu AOI Boundary', true);
// ==========================================================================
// 6. EXPORT CONFIGURATION WITH GRID ALIGNMENT & PYRAMIDING
// ==========================================================================
// Extract projection object configuration properties into a client-side dictionary object
tmfProj = tmfProj.getInfo();
// Define target output Earth Engine Asset path using version identifier string
var assetPath = '_' + verExport;
// Submit export task to GEE Task Manager using server-side CRS and transform from TMF anchor projection
Export.image.toAsset({
  image: votersAndOverrides,                            
  description: 'Export_Voters_And_Overrides_' + verExport, 
  assetId: assetPath,                                   
  crs: tmfProj.crs,                                     
  crsTransform: tmfProj.transform,                      
  region: AOI_GEOM,                                     
  pyramidingPolicy: {'.default': 'mode'},              
  maxPixels: 1e13                                       
});
