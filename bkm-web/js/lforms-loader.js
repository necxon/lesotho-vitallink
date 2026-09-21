/*
 * NEC XON (c) Copyright 2025.
 *
 * Lazy loader for LHC-Forms (https://lhncbc.github.io/lforms/).
 *
 * WHY LHC-FORMS AT ALL
 * The portal used to render FHIR Questionnaires with a hand-rolled renderer of
 * about 170 lines. It drew every item unconditionally, because it did not
 * implement enableWhen, itemControl, calculated expressions, repeats or initial
 * values - and the questionnaires in this deployment use all five. A form the
 * phone shows as five questions could render here as twenty, so the preview
 * could not be used to check what a health worker actually sees.
 *
 * LHC-Forms is the NLM's reference FHIR Questionnaire renderer and implements
 * the SDC behaviours the phone's Android FHIR SDK renderer also implements. It
 * is not the same engine as the phone's, so it is a close model rather than a
 * guarantee - but it is a vastly better one than showing every field always.
 *
 * WHY LAZY
 * The bundle is ~3.8MB. Loading it in index.html would put that on every page
 * of the portal, including the ones that never render a form. It is fetched the
 * first time a form is opened and cached by the browser thereafter (nginx marks
 * /vendor/ immutable).
 *
 * WHY VENDORED
 * The server may have no outbound internet, so a CDN is not an option. See
 * bkm-web/vendor/lforms/VERSION for what is checked in and how to update it.
 */
'use strict';

var _lformsPromise = null;

function _loadScript(src) {
  return new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = src;
    s.async = false; // order matters: zone, then lforms, then the FHIR support
    s.onload = resolve;
    s.onerror = function() { reject(new Error('could not load ' + src)); };
    document.head.appendChild(s);
  });
}

function _loadCss(href) {
  return new Promise(function(resolve) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    // Resolve either way: a missing stylesheet makes the form ugly, not broken,
    // and refusing to render over it would be the worse failure.
    l.onload = resolve;
    l.onerror = resolve;
    document.head.appendChild(l);
  });
}

/*
 * Resolves with the global LForms object. Safe to call repeatedly - the work
 * happens once and every later caller gets the same promise.
 */
function loadLForms() {
  if (_lformsPromise) return _lformsPromise;

  var base = 'vendor/lforms/';
  _lformsPromise = _loadCss(base + 'styles.css')
    .then(function() { return _loadScript(base + 'zone.min.js'); })
    .then(function() { return _loadScript(base + 'lhc-forms.js'); })
    .then(function() { return _loadScript(base + 'lformsFHIR.min.js'); })
    .then(function() {
      if (typeof LForms === 'undefined' || !LForms.Util) {
        throw new Error('LHC-Forms loaded but did not initialise');
      }
      return LForms;
    })
    .catch(function(e) {
      // Clear the cached promise so a later attempt can retry rather than
      // replaying the same failure forever.
      _lformsPromise = null;
      throw e;
    });

  return _lformsPromise;
}

/*
 * Render a FHIR Questionnaire into a container element.
 *
 * Conversion is explicit rather than letting addFormToPage sniff the input,
 * so a Questionnaire that LHC-Forms cannot convert fails here with a clear
 * message instead of rendering as a blank panel.
 */
function lformsRender(questionnaire, containerId, options) {
  return loadLForms().then(function(LF) {
    var container = document.getElementById(containerId);
    if (!container) throw new Error('container ' + containerId + ' is not on the page');
    container.innerHTML = '';
    var lfData = LF.Util.convertFHIRQuestionnaireToLForms(questionnaire, 'R4');
    LF.Util.addFormToPage(lfData, containerId, options || {});
    return container;
  });
}

/*
 * Pull the answers back out as a FHIR QuestionnaireResponse - the same resource
 * type the phone posts, so what is submitted here travels the same path.
 */
function lformsResponse(containerId) {
  var container = document.getElementById(containerId);
  return LForms.Util.getFormFHIRData('QuestionnaireResponse', 'R4', container);
}
