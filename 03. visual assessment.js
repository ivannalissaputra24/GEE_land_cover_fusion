// ----------------------------------------------------------------------------
// 0. GLOBAL PARAMETERS & CONFIGURATION
// ----------------------------------------------------------------------------
var verInput = "v8";

var AOI_ASSET = 'users/saputraivannalis24/modified_jrc_tmf/admin_kh_big_2023';
var AOI       = ee.FeatureCollection(AOI_ASSET);
var AOI_GEOM  = AOI.geometry();

var assetPath = 'users/saputraivannalis24/modified_jrc_tmf/';

// Tahun yang dibandingkan
var years = [];
for (var yy = 2015; yy <= 2025; yy++) years.push(yy);

// Kelas TMF AnnualChanges
var CLASS_NAMES = {
  1: 'Undisturbed TMF',
  2: 'Degraded TMF',
  3: 'Deforested land',
  4: 'Forest regrowth',
  5: 'Permanent & seasonal water',
  6: 'Other land cover'
};
var classIds = [1, 2, 3, 4, 5, 6];
var CLASS_PALETTE = ['005000', '00a000', 'e59900', 'a0e500', '0000ff', 'dcdcdc'];

// Kelas hutan pada Original TMF (Undisturbed + Degraded)
var FOREST_CLASSES = [1, 2];

// Perhitungan: jumlah piksel -> hektar (30 m x 30 m = 0.09 ha).
// Dekat ekuator (Kalimantan Barat) pendekatan ini sangat baik.
var COUNT_SCALE = 30;
var PIXEL_HA    = 0.09;

// Label grafik: ha -> km2 (1 km2 = 100 ha), maksimum 4 digit signifikan
// contoh: 2056 ha -> '20.56', 123456 ha -> '1235'
var HA_TO_KM2 = 0.01;
function fmtKm2(v) {
  return String(Number(v.toPrecision(4)));
}

// Landsat: periode bulan kering (ubah sesuai kebutuhan)
var DRY_START = '06-01';
var DRY_END   = '10-01';   // batas akhir eksklusif -> Jun s/d Sep
var LS_VIS = {bands: ['SR_B6', 'SR_B5', 'SR_B4'], min: 0.02, max: 0.40}; // SWIR1-NIR-Red
// Alternatif natural color: bands ['SR_B4','SR_B3','SR_B2'], min 0.02, max 0.2

// Polygon area terkoreksi: outline hitam solid, fill transparan 80% (alpha 0x33 = 20% opasitas)
var POLY_OUTLINE  = 'black';
var POLY_FILL     = '00000033';
var POLY_MIN_ZOOM = 10;   // polygon baru dibuat jika zoom >= nilai ini

// Pemisah antar panel peta
var DIVIDER_COLOR = 'black';   // coba 'white' atau '#444444' sesuai selera
var DIVIDER_WIDTH = '4px';

// ----------------------------------------------------------------------------
// 1. DATA LOADERS
// ----------------------------------------------------------------------------
var jrcTmfOriginal = ee.ImageCollection('projects/JRC/TMF/v1_2025/AnnualChanges')
                       .filter(ee.Filter.eq('system:index', 'ASIA'))
                       .first()
                       .clip(AOI_GEOM);

// Original: band 'Dec<tahun>' -> 'class'
function getOrig(y) {
  return jrcTmfOriginal.select('Dec' + y).toInt().rename('class');
}

// Corrected: asset per tahun (diasumsikan band pertama = kelas 1-6)
function getCorr(y) {
  return ee.Image(assetPath + 'corrected_tmf_' + y + '_' + verInput)
           .select(0).toInt().rename('class').clip(AOI_GEOM);
}

// Mask hutan dari Original TMF (kelas 1 + 2)
function getForestMask(o) {
  return o.eq(FOREST_CLASSES[0]).or(o.eq(FOREST_CLASSES[1]));
}

// ----------------------------------------------------------------------------
// 2. KOMPARASI LUAS (ha) PER KELAS: ORIGINAL vs CORRECTED
//    Satu reduceRegion per tahun (histogram 2 band) -> dipakai untuk 6 chart.
// ----------------------------------------------------------------------------
var statFeatures = years.map(function (y) {
  var stack = getOrig(y).rename('orig').addBands(getCorr(y).rename('corr'));
  var hist = stack.reduceRegion({
    reducer: ee.Reducer.frequencyHistogram().forEachBand(stack),
    geometry: AOI_GEOM,
    scale: COUNT_SCALE,
    maxPixels: 1e13,
    tileScale: 8
  });
  var ho = ee.Dictionary(hist.get('orig'));
  var hc = ee.Dictionary(hist.get('corr'));
  var props = {year: y};
  classIds.forEach(function (k) {
    props['o_' + k] = ee.Number(ho.get(String(k), 0)).multiply(PIXEL_HA);
    props['c_' + k] = ee.Number(hc.get(String(k), 0)).multiply(PIXEL_HA);
  });
  return ee.Feature(null, props);
});
var statFC = ee.FeatureCollection(statFeatures);

var chartPanel = ui.Panel({style: {width: '100%'}});
chartPanel.add(ui.Label('Calculate area statistics (km²) ... Please wait.',
                        {color: 'gray', fontSize: '12px'}));

statFC.evaluate(function (fc, err) {
  chartPanel.clear();
  if (err) {
    chartPanel.add(ui.Label('Error: ' + err, {color: 'red'}));
    return;
  }
  classIds.forEach(function (k, i) {
    var rows = fc.features.map(function (f) {
      var oKm2 = f.properties['o_' + k] * HA_TO_KM2;
      var cKm2 = f.properties['c_' + k] * HA_TO_KM2;
      return {c: [
        {v: String(f.properties.year)},
        {v: oKm2},
        {v: fmtKm2(oKm2)},   // label di atas bar Original
        {v: cKm2},
        {v: fmtKm2(cKm2)}    // label di atas bar Corrected
      ]};
    });
    var table = {
      cols: [
        {id: 'year', label: 'Year', type: 'string'},
        {id: 'orig', label: 'Original', type: 'number'},
        {id: 'orig_ann', type: 'string', p: {role: 'annotation'}},
        {id: 'corr', label: 'Corrected', type: 'number'},
        {id: 'corr_ann', type: 'string', p: {role: 'annotation'}}
      ],
      rows: rows
    };
    var chart = ui.Chart(table, 'ColumnChart', {
      title: k + ' - ' + CLASS_NAMES[k] + ' (2015-2025)',
      hAxis: {title: 'Year'},
      vAxis: {title: 'Area (km²)'},
      colors: ['9e9e9e', '#' + CLASS_PALETTE[i]],
      legend: {position: 'bottom'},
      bar: {groupWidth: '75%'},
      annotations: {alwaysOutside: true, textStyle: {fontSize: 8, color: '#333333'}},
      height: '260px'
    });
    chartPanel.add(chart);
  });
});

// ----------------------------------------------------------------------------
// 3. LANDSAT MEDIAN KOMPOSIT BULAN KERING
// ----------------------------------------------------------------------------
function maskLandsat(img) {
  var qa = img.select('QA_PIXEL');
  // bit 1 dilated cloud, 2 cirrus, 3 cloud, 4 cloud shadow
  var mask = qa.bitwiseAnd(parseInt('11110', 2)).eq(0);
  var sr = img.select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6'])
              .multiply(0.0000275).add(-0.2);
  return sr.updateMask(mask);
}

function getLandsat(y) {
  var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2');
  var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2');
  return l8.merge(l9)
           .filterBounds(AOI_GEOM)
           .filterDate(y + '-' + DRY_START, y + '-' + DRY_END)
           .map(maskLandsat)
           .median()
           .clip(AOI_GEOM);
}

// ----------------------------------------------------------------------------
// 4. UI: 3 PANEL TERHUBUNG
// ----------------------------------------------------------------------------
var mapO = ui.Map().setOptions('SATELLITE');
var mapC = ui.Map().setOptions('SATELLITE');
var mapL = ui.Map().setOptions('SATELLITE');
ui.Map.Linker([mapO, mapC, mapL]);
mapO.centerObject(AOI_GEOM, 9);

function mapLabel(text) {
  return ui.Label(text, {
    position: 'top-left', fontWeight: 'bold', fontSize: '13px',
    backgroundColor: 'rgba(255,255,255,0.8)', padding: '3px 6px'
  });
}
var labO = mapLabel('Original'), labC = mapLabel('Corrected'), labL = mapLabel('Satellite imagery');
mapO.add(labO); mapC.add(labC); mapL.add(labL);

var classVis = {min: 1, max: 6, palette: CLASS_PALETTE};

// Legenda kelas (di panel Original)
var legend = ui.Panel({style: {position: 'bottom-left', padding: '6px'}});
classIds.forEach(function (k, i) {
  legend.add(ui.Panel([
    ui.Label('', {backgroundColor: '#' + CLASS_PALETTE[i], padding: '7px', margin: '2px 4px 2px 0'}),
    ui.Label(k + ' ' + CLASS_NAMES[k], {fontSize: '11px', margin: '2px 0'})
  ], ui.Panel.Layout.flow('horizontal')));
});
mapO.add(legend);

var currentDiff = null;   // mask piksel yang kelasnya berbeda (Original vs Corrected)
var polyLayers = {};      // layer polygon per panel (agar bisa di-update tanpa reset)
var forestOnly = true;   // state checkbox "Forest extent only"

var POLY_STYLE = {color: POLY_OUTLINE, fillColor: POLY_FILL, width: 1};
var EMPTY_POLYS = ee.FeatureCollection([ee.Feature(null)]);

// Polygon area terkoreksi dibuat otomatis untuk extent peta yang sedang terlihat.
// Di bawah zoom POLY_MIN_ZOOM polygon tidak dibuat (terlalu berat).
function buildPolys() {
  var z = mapL.getZoom();
  var b = mapL.getBounds();
  if (!currentDiff || !b || z === undefined || z < POLY_MIN_ZOOM) return EMPTY_POLYS;
  return currentDiff.reduceToVectors({
    geometry: ee.Geometry.Rectangle(b),
    scale: 30,
    geometryType: 'polygon',
    eightConnected: true,
    maxPixels: 1e10,
    bestEffort: true
  });
}

function updatePolygons() {
  var styled = buildPolys().style(POLY_STYLE);
  Object.keys(polyLayers).forEach(function (k) {
    polyLayers[k].setEeObject(styled);
  });
}

function updateAll(yearStr) {
  var y = Number(yearStr);
  var o = getOrig(y);
  var c = getCorr(y);

  var fm = getForestMask(o);   // extent hutan Original (kelas 1 + 2)

  // Piksel yang kelasnya berubah setelah koreksi
  // (jika forestOnly aktif: hanya di dalam extent hutan Original)
  var diff = o.neq(c);
  currentDiff = (forestOnly ? diff.and(fm) : diff).selfMask().rename('diff');

  // Tampilan: Original & Corrected sama-sama dibatasi extent hutan Original
  var oShow = forestOnly ? o.updateMask(fm) : o;
  var cShow = forestOnly ? c.updateMask(fm) : c;

  [mapO, mapC, mapL].forEach(function (m) { m.layers().reset(); });

  var suffix = forestOnly ? ' (forest extent)' : '';
  mapO.addLayer(oShow, classVis, 'Original ' + y + suffix);
  mapC.addLayer(cShow, classVis, 'Corrected ' + y + suffix);
  mapL.addLayer(getLandsat(y), LS_VIS, 'Landsat dry-season median ' + y, false);

  // Layer polygon area terkoreksi (masuk ke layer list bawaan GEE di tiap panel)
  polyLayers = {};
  [['O', mapO], ['C', mapC], ['L', mapL]].forEach(function (p) {
    var layer = ui.Map.Layer({
      eeObject: EMPTY_POLYS.style(POLY_STYLE),
      visParams: {},
      name: 'Polygon area terkoreksi'
    });
    p[1].layers().add(layer);
    polyLayers[p[0]] = layer;
  });
  updatePolygons();

  labO.setValue('Original ' + y + (forestOnly ? ' - forest (1+2)' : ''));
  labC.setValue('Corrected ' + y + (forestOnly ? ' - within Original forest' : ''));
  // labL.setValue('Landsat median ' + y + ' (' + DRY_START + ' s/d ' + DRY_END + ')');
}

var yearSelect = ui.Select({
  items: years.map(String),
  value: '2025',
  onChange: updateAll,
  style: {stretch: 'horizontal'}
});

var forestCheck = ui.Checkbox({
  label: 'Forest extent only (Original class 1+2)',
  value: false,
  onChange: function (v) {
    forestOnly = v;
    updateAll(yearSelect.getValue());
  },
  style: {fontSize: '12px'}
});

var side = ui.Panel({style: {padding: '8px'}});
side.add(ui.Label('TMF Original vs Corrected (' + verInput + ')',
                  {fontWeight: 'bold', fontSize: '16px'}));
side.add(ui.Label('Year selection:', {fontSize: '12px'}));
side.add(yearSelect);
side.add(forestCheck);
// side.add(ui.Label('Polygon area terkoreksi otomatis muncul saat zoom >= ' + POLY_MIN_ZOOM +
//                   ' (layer "Polygon area terkoreksi").', {fontSize: '11px', color: 'gray'}));
side.add(ui.Label('Area comparasion (km²)', {fontWeight: 'bold', margin: '10px 0 0 0'}));
side.add(chartPanel);

// Pemisah vertikal tipis antar peta (lebar tetap, tinggi mengikuti peta)
function divider() {
  return ui.Panel({
    style: {
      width: DIVIDER_WIDTH,
      backgroundColor: "white",
      margin: '0px',
      padding: '0px',
      stretch: 'vertical',
    }
  });
}

// 3 panel Original | Corrected | Landsat dalam satu baris horizontal.
// Tiap peta 'stretch: both' -> sisa lebar (setelah divider) dibagi rata dan
// otomatis menyesuaikan saat divider panel perbandingan luas digeser.
[mapO, mapC, mapL].forEach(function (m) {
  m.style().set({stretch: 'both'});
});
var mapsRow = ui.Panel(
  [mapO, divider(), mapC, divider(), mapL],
  ui.Panel.Layout.flow('horizontal'),
  {stretch: 'both'}
);

ui.root.clear();
ui.root.add(ui.SplitPanel({
  firstPanel: mapsRow, secondPanel: side, orientation: 'horizontal'
}));

updateAll('2025');

// Regenerasi polygon otomatis saat peta digeser/zoom (panel terhubung -> cukup satu listener)
mapL.onChangeBounds(ui.util.debounce(updatePolygons, 1000));
