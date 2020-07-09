var gaul = ee.FeatureCollection("FAO/GAUL/2015/level1");
var gfsad = ee.Image("USGS/GFSAD1000_V0");
// Select 'landcover' band with pixel values 1 
// which represent Rice and Wheat Rainfed crops
var wheatrice = gfsad.select('landcover').eq(1)

// Uttar Pradesh is a large state in Indo-Gangetic Plain with
// a large agricultural output.
// We use the Global Administrative Unit Layers (GAUL) dataset to get
// the state boundary
var uttarpradesh = gaul.filter(ee.Filter.eq('ADM1_NAME', 'Uttar Pradesh'))

// wheatrice image contains 1 and 0 pixels. We want to generate points
// only in the pixels that are 1 (representing crop areas)
// selfMask() masks the pixels with 0 value.
var points = wheatrice.selfMask().stratifiedSample({numPoints:100, region:uttarpradesh, geometries: true} )

// We need a unique id for each point. We take the feature id and set it as
// a property so we can refer to each point easily
var points = points.map(function(feature) {
  return ee.Feature(feature.geometry(), {'id': feature.id()})
})

// Show the state polygon with a blue outline
var outline = ee.Image().byte().paint({
  featureCollection: uttarpradesh,
  color: 1,
  width: 3
});


// Cloud masking
function maskCloudAndShadows(image) {
  var cloudProb = image.select('MSK_CLDPRB');
  var snowProb = image.select('MSK_SNWPRB');
  var cloud = cloudProb.lt(5);
  var snow = snowProb.lt(5);
  var scl = image.select('SCL'); 
  var shadow = scl.eq(3); // 3 = cloud shadow
  var cirrus = scl.eq(10); // 10 = cirrus
  // Cloud probability less than 5% or cloud shadow classification
  var mask = (cloud.and(snow)).and(cirrus.neq(1)).and(shadow.neq(1));
  return image.updateMask(mask);
}

// Adding a NDVI band
function addNDVI(image) {
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('ndvi')
  return image.addBands([ndvi])
}

var startDate = '2019-01-01'
var endDate = '2019-12-31'

// Use Sentinel-2 L2A data - which has better cloud masking
var collection = ee.ImageCollection('COPERNICUS/S2_SR')
    .filterDate(startDate, endDate)
    .map(maskCloudAndShadows)
    .map(addNDVI)
    .filter(ee.Filter.bounds(points))

// View the median composite
var vizParams = {bands: ['B4', 'B3', 'B2'], min: 0, max: 2000}
Map.addLayer(collection.median(), vizParams, 'collection')
Map.addLayer(outline, {palette: ['blue']}, 'AOI')
// Show the farm locations in green
Map.addLayer(points, {color: 'green'}, 'Farm Locations')

var getImage = function(id) {
  return ee.Image(collection.filter(ee.Filter.eq('system:index', id)).first())
}

Map.addLayer(points.filter(ee.Filter.eq('id', '6')))
var testPoint = ee.Feature(points.first())
//Map.centerObject(testPoint, 10)
var chart = ui.Chart.image.series({
    imageCollection: collection.select('ndvi'),
    region: testPoint.geometry()
    }).setOptions({
      interpolateNulls: true,
      lineWidth: 1,
      pointSize: 3,
      title: 'NDVI over Time at a Single Location',
      vAxis: {title: 'NDVI'},
      hAxis: {title: 'Date', format: 'YYYY-MMM', gridlines: {count: 12}}

    })
print(chart)

// We can chart a single value for all points
// Here we take the maximum NDVI and show how it compares
// across all points
var testImage = collection.select('ndvi').max()
var stats = testImage.reduceRegions({
  collection: points,
  reducer: ee.Reducer.mean().setOutputs(['ndvi']),
  scale: 10
  })


var chart = ui.Chart.feature.byFeature({
  features: stats,
  yProperties: ['ndvi']}) 
  .setChartType('ColumnChart')
  .setOptions({
      interpolateNulls: false,
      lineWidth: 1,
      pointSize: 3,
      title: 'Maximum NDVI for Year 2019',
      vAxis: {title: 'NDVI'},
      hAxis: {title: 'Feature ID'}

    })
print(chart);


var chart = ui.Chart.image.seriesByRegion({
    imageCollection: collection.select('ndvi'),
    regions: points,
    reducer: ee.Reducer.mean()
})
// This doesn't work as the result is to large to print
print(chart)

var triplets = collection.map(function(image) {
  return image.select('ndvi').reduceRegions({
    collection: points, 
    reducer: ee.Reducer.first().setOutputs(['ndvi']), 
    scale: 10,
  })// reduceRegion doesn't return any output if the image doesn't intersect
    // with the point or if the image is masked out due to cloud
    // If there was no ndvi value found, we set the ndvi to a NoData value -9999
    .map(function(feature) {
    var ndvi = ee.List([feature.get('ndvi'), -9999])
      .reduce(ee.Reducer.firstNonNull())
    return feature.set({'ndvi': ndvi, 'imageID': image.id()})
    })
  }).flatten();

var format = function(table, rowId, colId) {
  var rows = table.distinct(rowId); 
  var joined = ee.Join.saveAll('matches').apply({
    primary: rows, 
    secondary: table, 
    condition: ee.Filter.equals({
      leftField: rowId, 
      rightField: rowId
    })
  });
        
  return joined.map(function(row) {
      var values = ee.List(row.get('matches'))
        .map(function(feature) {
          feature = ee.Feature(feature);
          return [feature.get(colId), feature.get('ndvi')];
        });
      return row.select([rowId]).set(ee.Dictionary(values.flatten()));
    });
};

var sentinelResults = format(triplets, 'id', 'imageID');

// There are multiple image granules for the same date processed from the same orbit
// Granules overlap with each other and since they are processed independently
// the pixel values can differ slightly. So the same pixel can have different NDVI 
// values for the same date from overlapping granules.
// So to simplify the output, we can merge observations for each day
// And take the max ndvi value from overlapping observations
var merge = function(table, rowId) {
  return table.map(function(feature) {
    var id = feature.get(rowId)
    var allKeys = feature.toDictionary().keys().remove(rowId)
    var substrKeys = ee.List(allKeys.map(function(val) { 
        return ee.String(val).slice(0,8)}
        ))
    var uniqueKeys = substrKeys.distinct()
    var pairs = uniqueKeys.map(function(key) {
      var matches = feature.toDictionary().select(allKeys.filter(ee.Filter.stringContains('item', key))).values()
      var val = matches.reduce(ee.Reducer.max())
      return [key, val]
    })
    return feature.select([rowId]).set(ee.Dictionary(pairs.flatten()))
  })
}
var sentinelMerged = merge(sentinelResults, 'id');

Export.table.toDrive({
    collection: sentinelMerged,
    description: 'NDVI_time_series',
    folder: 'earthengine',
    fileNamePrefix: 'ndvi_time_series',
    fileFormat: 'CSV'
})