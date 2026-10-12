/**
 * ============================================================================
 * JRC-TMF FOREST COVER HARMONIZATION, TEMPORAL PROPAGATION & ACCURACY ASSESSMENT
 * ============================================================================
 * Description: 
 * This script automates spatial voting correction, GHSL built-up overriding, minimum 
 * mapping unit (MMU) filtering, and rule-based iterative multi-year temporal propagation.
 * 
 * Version: v8
 * ============================================================================
 */
// Set to FALSE for processing and accuracy assessment only (exploratory mode); 
// Set to TRUE to export final multi-year results to both GEE Assets and Google Drive.
var isReadyToUsePhase = true;
// Check the active phase mode and output the corresponding status message to the Console
if (!isReadyToUsePhase) {
  print('Status: You are in assessing/exploratory phase mode.');
} else {
  print('Status: You are in ready-to-use production phase mode.');
}
// ----------------------------------------------------------------------------
// 0. GLOBAL PARAMETERS & CONFIGURATION
// ----------------------------------------------------------------------------
var verInput  = "v6"; // Input version string for loading multi-band voter and override assets
// Note: V8 without MoEF and Plasar, include MBI
var verExport = "v8"; // Output version string used for naming exported raster assets, files, and directories
var BASE_YEAR = 2015; // Baseline reference year for spatial voting, override filtering, and MMU mask
var ACC_YEAR  = 2020; // Designated evaluation year used for single-year accuracy assessment workflow
// Toggle flag to apply (true) or bypass (false) the GHSL built-up settlement absolute override mask
var USE_OVERRIDE = true;
// Define array of target years to process, monitor, and visualize interactively in the map panel
var TARGET_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
// Determine the maximum year from the target years array to establish the upper temporal bound
var END_YEAR = TARGET_YEARS.reduce(function(a, b) { return Math.max(a, b); });
// Asset ID path for the Kapuas Hulu administrative boundary FeatureCollection (Area of Interest)
var AOI_ASSET = 'users/saputraivannalis24/modified_jrc_tmf/admin_kh_big_2023';
// Root directory asset path for storing and retrieving output Earth Engine raster assets
var assetPath = 'users/saputraivannalis24/modified_jrc_tmf/';
// Google Drive target folder name dynamically generated for the ready-to-use export phase
var driveFolder = 'JRC_TMF_Harmonization_' + verExport;
// ----------------------------------------------------------------------------
// 1. AOI & ASSET INPUT LOADING
// ----------------------------------------------------------------------------
var AOI      = ee.FeatureCollection(AOI_ASSET); // Load administrative boundary vector collection into memory
var AOI_GEOM = AOI.geometry();                  // Extract boundary geometry polygon for spatial filtering and clipping
// Construct the full asset path for the multi-band voter and absolute override raster layer
var assetVoters = 'users/saputraivannalis24/modified_jrc_tmf/voters_and_overrides_' + verInput;
// Load the multi-band voter and override raster image into memory
var votersAndOverrides = ee.Image(assetVoters);
print('Loaded Voters/Overrides Image:', votersAndOverrides);
// Load the official JRC-TMF Annual Changes collection, filter for the Asian regional mosaic, select the first image, and clip to AOI
var jrcTmfMosaic = ee.ImageCollection('projects/JRC/TMF/v1_2025/AnnualChanges')
                     .filter(ee.Filter.eq("system:index","ASIA"))
                     .first()
                     .clip(AOI_GEOM);
// Print the clipped JRC-TMF mosaic details to the console for spatial validation
print('JRC-TMF Annual Changes Mosaic (Clipped to AOI):', jrcTmfMosaic);
// Extract the baseline land cover classification raster band corresponding to December of BASE_YEAR (2015)
var tmf2015 = jrcTmfMosaic.select("Dec" + BASE_YEAR);
// ----------------------------------------------------------------------------
// 2. ISOLATE TARGET FOREST CLASSES (CLASS 1 & CLASS 2)
// ----------------------------------------------------------------------------
// Generate a binary mask identifying baseline target forest pixels: Undisturbed Forest (Class 1) or Degraded Forest (Class 2)
var isTargetForest = tmf2015.eq(1).or(tmf2015.eq(2));
// ----------------------------------------------------------------------------
// 3. VOTING AGGREGATION
// ----------------------------------------------------------------------------
// Print available band names in the loaded voters and overrides asset for structure verification
print("Available Voters/Overrides Layer Bands:", votersAndOverrides.bandNames());
// Select independent land cover classification voter bands used for consensus majority voting
var voterBands = votersAndOverrides.select([
  "voter_glclu",
  "voter_hansen",
  "voter_glance",
  // "voter_palsar", 
  "voter_gc",
  "voter_gcep",
  // "voter_moef",
  "voter_mbi", 
  "voter_oilpalm",
  "voter_mining" 
]);
// Calculate the total cumulative count of independent datasets voting for Forest (pixel value equals 1)
var forestVotes = voterBands.eq(1).reduce(ee.Reducer.sum());
// Calculate the total cumulative count of independent datasets voting for Non-Forest (pixel value equals 2)
var nonForestVotes = voterBands.eq(2).reduce(ee.Reducer.sum());
// Calculate total valid votes per pixel by aggregating Forest and Non-Forest votes (excluding 0/Abstain values)
var validVotes = forestVotes.add(nonForestVotes);
// Print selected voter bands structure to console for verification
print('Selected Voters/Overrides Layer Bands:', voterBands);
// ----------------------------------------------------------------------------
// 4. CONSERVATIVE MAJORITY VOTING LOGIC
// ----------------------------------------------------------------------------
// Define reclassification condition: target forest pixel must have >= 2 valid votes, 
// and Non-Forest votes must strictly exceed Forest votes to override baseline forest status
var isReclassifiedToNF = isTargetForest
  .and(validVotes.gte(2))
  .and(nonForestVotes.gt(forestVotes));
// Reclassify pixels fulfilling the conservative majority voting condition from forest to Other Non-Forest (Class 6)
var tmfAfterVoting = tmf2015.where(isReclassifiedToNF, 6);
// ----------------------------------------------------------------------------
// 5. OPTIONAL ABSOLUTE OVERRIDE (GHSL SETTLEMENTS)
// ----------------------------------------------------------------------------
// Select the GHSL built-up settlement absolute override raster band from the multi-band stack
var overrideGHSL = votersAndOverrides.select('override_ghsl');
// Create a binary mask identifying confirmed built-up settlement pixels (pixel value equals 2)
var isOverrideNF = overrideGHSL.eq(2);
// Conditionally force built-up settlement pixels to Non-Forest (Class 6) if USE_OVERRIDE flag is active (true)
var tmfAfterOverride = USE_OVERRIDE
  ? tmfAfterVoting.where(isOverrideNF, 6)
  : tmfAfterVoting;
// ----------------------------------------------------------------------------
// 6. MINIMUM MAPPING UNIT (MMU) FILTERING (0.25 HA / ~3 PIXELS @ 30M)
// ----------------------------------------------------------------------------
// Create a binary mask for remaining forest pixels (Class 1 or 2) following voting and override steps
var forestMask = tmfAfterOverride.eq(1).or(tmfAfterOverride.eq(2));
// Calculate the contiguous connected forest pixel count utilizing an 8-connected neighborhood rule
var connectedCount = forestMask.connectedPixelCount({maxSize: 8, eightConnected: true});
// Identify isolated forest clusters containing fewer than 3 connected pixels (< ~0.27 hectares)
var isBelowMMU = forestMask.and(connectedCount.lt(3));
// Reclassify isolated sub-MMU forest patches to Non-Forest (6), rename output band, and assign metadata properties
var tmfFinal = tmfAfterOverride.where(isBelowMMU, 6).rename('tmf_' + BASE_YEAR + '_corrected')
                                 .set({"year": BASE_YEAR, "version": verExport});
// ----------------------------------------------------------------------------
// 7. BASELINE QA STRATA CREATION
// ----------------------------------------------------------------------------
// Initialize a quality assessment (QA) strata raster image initialized to 0 and named 'qa_strata'
var qaStrata = ee.Image(0).rename('qa_strata');
// Create a mask for pixels originally classified as forest (Class 1 or 2) in the raw 2015 JRC-TMF dataset
var origForest = tmf2015.eq(1).or(tmf2015.eq(2));
// Create a mask for pixels retained as forest (Class 1 or 2) in the finalized 2015 corrected baseline image
var isFinalForest = tmfFinal.eq(1).or(tmfFinal.eq(2));
// Create a mask for pixels reclassified or set as Non-Forest (Class 6) in the final corrected image
var isFinalNF = tmfFinal.eq(6);
// Assign Strata 2: Pixels that were already categorized as non-forest in the original raw dataset
qaStrata = qaStrata.where(origForest.not(), 2);
// Define a mask for forest pixels reclassified specifically by the GHSL built-up settlement override
var strata4Mask = USE_OVERRIDE
  ? origForest.and(isFinalNF).and(isOverrideNF)
  : ee.Image(0);
// Assign Strata 4: Forest pixels corrected specifically via urban/settlement absolute override
qaStrata = qaStrata.where(strata4Mask, 4);
// Define a mask for forest pixels reclassified by majority voting consensus or MMU patch elimination
var strata3Mask = USE_OVERRIDE
  ? origForest.and(isFinalNF).and(isOverrideNF.not())
  : origForest.and(isFinalNF);
// Assign Strata 3: Forest pixels corrected by multi-source majority voting or MMU cleaning rules
qaStrata = qaStrata.where(strata3Mask, 3);
// Assign Strata 5: Disputed pixels that received >= 1 Non-Forest vote from independent sources but were retained as forest
qaStrata = qaStrata.where(origForest.and(isFinalForest).and(nonForestVotes.gt(0)), 5);
// Assign Strata 1: Undisputed clean forest pixels with 0 Non-Forest votes across all active voter models
qaStrata = qaStrata.where(origForest.and(isFinalForest).and(nonForestVotes.eq(0)), 1);
// ----------------------------------------------------------------------------
// 8. MAP VISUALIZATION (BASE YEAR) & UI LEGEND CONFIGURATION
// ----------------------------------------------------------------------------
// Define color palette and min/max visualization parameters conforming to standard JRC-TMF classes (1 to 6)
var tmfVis = {
  min: 1,
  max: 6,
  palette: ['005000', '00a000', 'e59900', 'a0e500', '0000ff', 'dcdcdc']
};
// Add original raw and final corrected baseline 2015 map layers to the interactive map interface
Map.addLayer(tmf2015, tmfVis, 'Original JRC-TMF ' + BASE_YEAR, false);
Map.addLayer(tmfFinal, tmfVis, 'Corrected JRC-TMF ' + BASE_YEAR + ' (Final Baseline)', false);
// Construct a custom UI legend panel container aligned to the bottom-left of the map view canvas
var legend = ui.Panel({
  style: {position: 'bottom-left', padding: '8px 15px', backgroundColor: 'rgb(255,255,255)'}
});
// Append a bold header title label to the legend control panel
legend.add(ui.Label('JRC-TMF Harmonization Legend', {fontWeight: 'bold', fontSize: '15px', margin: '0 0 8px 0'}));
// Helper function to build individual horizontal legend rows displaying a color indicator box and class description
var makeRow = function(color, name) {
  return ui.Panel({
    layout: ui.Panel.Layout.Flow('horizontal'),
    widgets: [
      ui.Label('', {backgroundColor: '#' + color, padding: '8px', margin: '0 8px 4px 0'}),
      ui.Label(name, {margin: '0 0 4px 0', fontSize: '12px'})
    ]
  });
};
// Define official hex color codes and corresponding descriptive land cover class labels
var classColors = ['005000', '00a000', 'e59900', 'a0e500', '0000ff', 'dcdcdc'];
var classNames  = ['1 - Undisturbed Forest', '2 - Degraded Forest', '3 - Deforested', '4 - Regrowth', '5 - Water', '6 - Other Non-Forest'];
// Loop through class definitions to dynamically append rows into the UI legend panel widget
for (var i = 0; i < classColors.length; i++) {
  legend.add(makeRow(classColors[i], classNames[i]));
}
// Add the completed legend panel widget to the interactive Map canvas
Map.add(legend);
// Extract spatial projection specifications from the reference mosaic collection
var tmfProj = jrcTmfMosaic.select(0).projection();
    tmfProj = tmfProj.getInfo();
// ----------------------------------------------------------------------------
// 8b. EXPORT BASELINE YEAR (2015) AS AN INDIVIDUAL GEE ASSET
// ----------------------------------------------------------------------------
// Export the finalized corrected 2015 baseline raster image as a permanent Earth Engine Asset
Export.image.toAsset({
  image: tmfFinal.toByte(),                                            
  description: 'corrected_tmf_' + BASE_YEAR + '_' + verExport,         
  assetId: assetPath + 'corrected_tmf_' + BASE_YEAR + '_' + verExport, 
  crs: tmfProj.crs,                                                    
  crsTransform: tmfProj.transform,                                     
  region: AOI_GEOM,                                                    
  scale: 30,                                                           
  pyramidingPolicy: {'.default': 'mode'},                              
  maxPixels: 1e13                                                      
});
// ----------------------------------------------------------------------------
// 8c. EXPORT BASELINE YEAR (2015) TO GOOGLE DRIVE
// ----------------------------------------------------------------------------
if (isReadyToUsePhase) {
  Export.image.toDrive({
    image: tmfFinal.toByte().set({"year": BASE_YEAR, "version": verExport}),
    description: 'drive_corrected_tmf_' + BASE_YEAR + '_' + verExport,
    folder: driveFolder,
    fileNamePrefix: 'corrected_tmf_' + BASE_YEAR + '_' + verExport,
    region: AOI_GEOM,
    crs: tmfProj.crs,
    crsTransform: tmfProj.transform,
    scale: 30,
    maxPixels: 1e13
  });
}
// ----------------------------------------------------------------------------
// 9. RULE-BASED ITERATIVE TEMPORAL PROPAGATION (BASE_YEAR -> END_YEAR) 
// ----------------------------------------------------------------------------
// Print active multi-year export execution plan message to console based on current workflow phase mode
print(isReadyToUsePhase
  ? 'Export Plan: Processing all target years (' + BASE_YEAR + '-' + END_YEAR + ') to both GEE Asset and Google Drive.'
  : 'Export Plan: Processing all years for visualization, exporting only accuracy year (' + ACC_YEAR + ') to GEE Asset.');
// Initialize the temporal tracking reference image pointer with the corrected baseline image
var Ref = tmfFinal;
// Initialize an empty client-side dictionary object to store corrected annual raster images
var correctedByYear = {};
correctedByYear[BASE_YEAR] = tmfFinal; // Register baseline corrected image inside the lookup dictionary
// Execute iterative loop to propagate structural forest corrections forward from BASE_YEAR + 1 through END_YEAR
for (var y = BASE_YEAR + 1; y <= END_YEAR; y++) {
  // Select raw annual JRC-TMF land cover classification image for current year y
  var Orig = jrcTmfMosaic.select("Dec" + y);
  // Extract persistence and transition tracking binary masks from the previous year's corrected image (Y-1)
  var RefForest     = Ref.eq(1).or(Ref.eq(2)); // Binary mask identifying forest status in year Y-1
  var RefNonForest  = RefForest.not();         // Binary mask identifying non-forest status in year Y-1
  var RefRegrowth   = Ref.eq(4);               // Binary mask identifying regrowth/recovery state in year Y-1
  var RefDeforested = Ref.eq(3);               // Binary mask identifying explicit deforestation state in year Y-1
  // Initialize current year calculation result using the raw annual JRC-TMF image as baseline
  var Result = Orig;
  // RULE 1 — Forest Extent Continuity Constraint: If previous year was non-forest (and not regrowth), force raw forest pixels to Non-Forest (6)
  var r1_invalid = RefNonForest.and(RefRegrowth.not());
  var origIsForest = Orig.eq(1).or(Orig.eq(2));
  Result = Result.where(origIsForest.and(r1_invalid), 6);
  // RULE 2 — Deforestation Irreversibility Constraint: If previous year was non-forest (and not designated deforested), force raw deforested pixels to Non-Forest (6)
  var r2_invalid = RefNonForest.and(RefDeforested.not());
  Result = Result.where(Orig.eq(3).and(r2_invalid), 6);
  // Rename output image band and attach system timestamp properties for time-series compatibility
  Result = Result.rename('tmf_' + y + '_corrected')
                 .set('system:time_start', ee.Date.fromYMD(y, 1, 1).millis());
  // Update temporal tracking reference image pointer and cache current year result in the dictionary
  Ref = Result;
  correctedByYear[y] = Result;
  // Determine if the current iteration year matches the designated accuracy evaluation year
  var isAccuracyYear = (y === ACC_YEAR);
  // Conditional task dispatching based on active production (ready-to-use) or exploratory phase mode
  if (isReadyToUsePhase) {
    // READY-TO-USE PHASE: Export corrected annual image layers to both Google Drive and GEE Assets
    Export.image.toDrive({
      image: Ref.toByte().set({"year": y, "version": verExport}), 
      description: 'drive_corrected_tmf_' + y + '_' + verExport,  
      folder: driveFolder,                                        
      fileNamePrefix: 'corrected_tmf_' + y + '_' + verExport,     
      region: AOI_GEOM,                                           
      crs: tmfProj.crs,                                           
      crsTransform: tmfProj.transform,                            
      scale: 30,                                                  
      maxPixels: 1e13                                             
    });
    Export.image.toAsset({
        image: Ref.toByte().set({"year": y, "version": verExport}),  
        description: 'corrected_tmf_' + y + '_' + verExport,         
        assetId: assetPath + 'corrected_tmf_' + y + '_' + verExport, 
        crs: tmfProj.crs,                                            
        crsTransform: tmfProj.transform,                             
        region: AOI_GEOM,                                            
        scale: 30,                                                   
        pyramidingPolicy: {'.default': 'mode'},                      
        maxPixels: 1e13                                              
    });
  } else {
    // ASSESSING/EXPLORATORY PHASE: Export raster assets selectively ONLY for the designated accuracy evaluation year
    if (isAccuracyYear) {
      Export.image.toAsset({
        image: Ref.toByte().set({"year": y, "version": verExport}),  
        description: 'corrected_tmf_' + y + '_' + verExport,         
        assetId: assetPath + 'corrected_tmf_' + y + '_' + verExport, 
        crs: tmfProj.crs,                                            
        crsTransform: tmfProj.transform,                             
        region: AOI_GEOM,                                            
        scale: 30,                                                   
        pyramidingPolicy: {'.default': 'mode'},                      
        maxPixels: 1e13                                              
      });
    }
  }
  // Conditionally add annual original and corrected visualization layers to map UI if present in the target years array
  if (TARGET_YEARS.indexOf(y) !== -1) {
    var isVisible = (y === ACC_YEAR); // Set default visibility active only for the designated accuracy year layer
    Map.addLayer(Orig, tmfVis, 'Original JRC-TMF ' + y, false); 
    Map.addLayer(Result, tmfVis, 'Corrected JRC-TMF ' + y, isVisible); 
  }
}

// Map.addLayer(table)
// ----------------------------------------------------------------------------
// 10. EXPORT QA STRATA (FOR STRATIFIED ACCURACY SAMPLING IN EXTERNAL SCRIPTS)
// ----------------------------------------------------------------------------
// Export the baseline quality assessment (QA) strata raster image unconditionally to a GEE Asset across all phases
Export.image.toAsset({
  image: qaStrata.toByte(),                                        
  description: 'qa_strata_' + BASE_YEAR + '_' + verExport,         
  assetId: assetPath + 'qa_strata_' + BASE_YEAR + '_' + verExport, 
  crs: tmfProj.crs,                                                
  crsTransform: tmfProj.transform,                                 
  region: AOI_GEOM,                                                
  scale: 30,                                                       
  pyramidingPolicy: {'.default': 'mode'},                          
  maxPixels: 1e13                                                  
});
// ----------------------------------------------------------------------------
// 11. ACCURACY ASSESSMENT WORKFLOW
// ----------------------------------------------------------------------------
var REF_FIELD  = 'validCheck'; // Attribute column name inside reference validation sample sets containing validation classes
var REF_NODATA = 0;            // NoData/invalid indicator value within reference attributes filtered out prior to analysis
// Asset paths pointing to independent reference validation sample polygon collections
var ACC_ASSET_RAND = 'users/saputraivannalis24/modified_jrc_tmf/acc_polygon_vRand';
var ACC_ASSET_GRIDDED = 'users/saputraivannalis24/modified_jrc_tmf/acc_polygon_vGridded';
// Load stratified random reference units collection and tag them with sample type property metadata
var refUnitsRand = ee.FeatureCollection(ACC_ASSET_RAND)
  .map(function(a) { return a.set({"sample_type": "stratified"}); });
// Load systematic gridded reference units collection and tag them with sample type property metadata
var refUnitsGridded = ee.FeatureCollection(ACC_ASSET_GRIDDED)
  .map(function(a) { return a.set({"sample_type": "gridded"}); });
// Merge both reference sample collections into a unified collection and filter out unlabelled/NoData reference units
var refUnits = refUnitsRand.merge(refUnitsGridded)
  .filter(ee.Filter.neq(REF_FIELD, REF_NODATA));
// Helper function to remap multi-class JRC-TMF categorical values into binary classes: Forest (1) & Non-Forest (2)
function remapTMF(img) {
  // Mapping scheme: Classes 1-2 -> Forest (1); Classes 3-6 -> Non-Forest (2)
  return img.remap([1,2,3,4,5,6],[1,1,2,2,2,2]);
}
// Extract, remap, and rename the corrected evaluation image for ACC_YEAR (2020)
var corrected2020 = ee.Image(correctedByYear[ACC_YEAR]);
    corrected2020 = remapTMF(corrected2020).rename("corrected");
// Extract, remap, and rename the raw uncorrected baseline JRC-TMF image for ACC_YEAR (2020)
var oriTmf2020 = jrcTmfMosaic.select("Dec" + ACC_YEAR);
    oriTmf2020 = remapTMF(oriTmf2020).rename("original");
// Stack corrected and original binary maps together into a single multi-band image container
var accStack = corrected2020.addBands(oriTmf2020);
// Extract map pixel values at reference sample point locations using regional spatial sampling
var samplesRaw = accStack.sampleRegions({
    collection: refUnits,
    properties: [REF_FIELD, "sample_type"],
    scale: 30,
    projection: oriTmf2020.projection(),
    geometries: true
});

Export.table.toDrive(
  {collection: samplesRaw, 
  description: "sample_" + verExport, 
  folder: driveFolder, 
  fileNamePrefix: "acc_sample_" + verExport, 
  fileFormat: "SHP"
})
/**
 * Computes statistical error matrices, overall accuracy, producer's accuracy, 
 * and consumer's accuracy for specified sample subsets and map versions.
 */
function r4(x) { return ee.Number(x).multiply(10000).round().divide(10000); }
 
// Rows = Reference, Columns = Map. Class 1 = Forest, class 2 = Non-Forest.
// Returns 2 features (Forest, Non-Forest) for one sample subset and map version.
function accAssessment(sampleFcInput, sampleType, mapBand) {
  var fc = (sampleType === 'all')
    ? sampleFcInput
    : sampleFcInput.filter(ee.Filter.eq('sample_type', sampleType));
 
  var m  = fc.errorMatrix(REF_FIELD, mapBand, [1, 2]);
  var a  = m.array();
  var pa = m.producersAccuracy().toList().flatten();
  var ua = m.consumersAccuracy().toList().flatten();
  var oa = r4(m.accuracy());
 
  var nForest    = ee.Number(a.get([0, 0])).add(ee.Number(a.get([0, 1])));  // reference = Forest
  var nNonForest = ee.Number(a.get([1, 0])).add(ee.Number(a.get([1, 1])));  // reference = Non-Forest
  
  var base = {
    'year': ACC_YEAR,
    'version': verExport,
    'Sample type': sampleType,
    'Map version': mapBand
  };
 
  function row(landCover, i, n) {
    var p = {};
    for (var k in base) p[k] = base[k];
    p['Land Cover'] = landCover;
    p['OA'] = oa;
    p['PA'] = r4(pa.get(i));
    p['UA'] = r4(ua.get(i));
    p['N samples'] = n;
    return ee.Feature(null, p);
  }
 
  return [row('Forest', 0, nForest), row('Non-Forest', 1, nNonForest)];
}
 
var rows = [];
['all', 'gridded', 'stratified'].forEach(function (st) {
  ['original', 'corrected'].forEach(function (mv) {
    rows = rows.concat(accAssessment(samplesRaw, st, mv));
  });
});
var accResultFinal = ee.FeatureCollection(rows);
 
print('Accuracy results:', accResultFinal);
 
Export.table.toDrive({
  collection: accResultFinal,
  description: 'Accuracy_Assessment_Results_' + verExport,
  folder: driveFolder,
  fileNamePrefix: 'accuracy_results_' + ACC_YEAR + '_' + verExport,
  fileFormat: 'CSV',
  selectors: [
    'year', 'version', 'Sample type', 'Map version',
    'Land Cover', 'OA', 'PA', 'UA', 'N samples'
  ]
});
 

