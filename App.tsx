import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import { handleItem, Item } from './editorUtils';

// TypeScript declarations for libraries loaded from CDN
declare var CodeMirror: any;
declare var katex: any;

// --- Helper: Render KaTeX math inside table cells and captions ---
function renderCellContent(container: HTMLElement, text: string) {
    // Supports both $...$ and \(...\) for inline math
    const inlineMathRegex = /\$((?:\\.|[^$])*?)\$|\\\(((?:\\.|[^)])*?)\\\)/g;
    let lastIndex = 0;
    let match;
    while ((match = inlineMathRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            container.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        }
        try {
            // Content is in capture group 1 for $...$ or 2 for \(...\)
            const mathContent = match[1] ?? match[2];
            const mathHtml = katex.renderToString(mathContent, { displayMode: false, throwOnError: true });
            const span = document.createElement('span');
            span.innerHTML = mathHtml;
            container.appendChild(span);
        } catch (e) {
            const errorSpan = document.createElement('span');
            errorSpan.className = 'katex-error-inline';
            errorSpan.textContent = match[0];
            errorSpan.title = e.message.replace('KaTeX parse error: ', '');
            container.appendChild(errorSpan);
        }
        lastIndex = inlineMathRegex.lastIndex;
    }
    if (lastIndex < text.length) {
        container.appendChild(document.createTextNode(text.substring(lastIndex)));
    }
}


// --- Helper: Parse and render a \begin{tabular} block to an HTML table ---
function renderTabular(latex: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'rendered-table-container';

    const tableMatch = latex.match(/\\begin{tabular}{(.*?)}([\s\S]*)\\end{tabular}/);
    if (!tableMatch) {
        container.textContent = latex;
        return container;
    }

    const colFormat = tableMatch[1];
    const content = tableMatch[2].trim();

    // Parse column formats
    const columns = [];
    let nextColHasLeftBorder = false;
    for (const char of colFormat) {
        if (['l', 'c', 'r'].includes(char)) {
            columns.push({ align: char, leftBorder: nextColHasLeftBorder, rightBorder: false });
            nextColHasLeftBorder = false;
        } else if (char === '|') {
            if (columns.length > 0) {
                columns[columns.length - 1].rightBorder = true;
            } else {
                nextColHasLeftBorder = true;
            }
        }
    }

    const table = document.createElement('table');
    table.className = 'rendered-table';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const rows = content.split(/\\\\/);
    let pendingHline = false;

    rows.forEach(rowStr => {
        let cleanRowStr = rowStr.trim();
        if (cleanRowStr.startsWith('\\hline')) {
            pendingHline = true;
            cleanRowStr = cleanRowStr.substring(6).trim();
        }

        if (!cleanRowStr) return;

        let hasBottomHline = false;
        if (/\\hline\s*$/.test(cleanRowStr)) {
            hasBottomHline = true;
            cleanRowStr = cleanRowStr.replace(/\\hline\s*$/, '').trim();
        }

        const tr = document.createElement('tr');
        if (pendingHline) {
            tr.classList.add('has-top-border');
            pendingHline = false;
        }

        const cells = cleanRowStr.split('&');
        cells.forEach((cellStr, cellIndex) => {
            const td = document.createElement('td');
            const colInfo = columns[cellIndex] || { align: 'c', leftBorder: false, rightBorder: false };

            if (colInfo.align === 'l') td.style.textAlign = 'left';
            else if (colInfo.align === 'r') td.style.textAlign = 'right';
            else td.style.textAlign = 'center';

            if (colInfo.leftBorder) td.classList.add('has-left-border');
            if (colInfo.rightBorder) td.classList.add('has-right-border');

            renderCellContent(td, cellStr.trim());
            tr.appendChild(td);
        });
        tbody.appendChild(tr);

        if (hasBottomHline) {
           tr.classList.add('has-bottom-border');
        }
    });
    
    // Add a bottom border if the table content ends with \hline
    if (pendingHline) {
        const lastTr = tbody.lastChild as HTMLElement;
        if (lastTr) lastTr.classList.add('has-bottom-border');
    }

    container.appendChild(table);
    return container;
}

// --- Helper: Render a \begin{table} block to an HTML figure ---
function renderTableEnvironment(latex: string): HTMLElement {
    const container = document.createElement('figure');
    container.className = 'rendered-table-figure';

    // Find and render the tabular part
    const tabularMatch = latex.match(/\\begin{tabular}{[\s\S]*?}[\s\S]*?\\end{tabular}/);
    if (tabularMatch) {
        const tableElement = renderTabular(tabularMatch[0]);
        container.appendChild(tableElement);
    }

    // Find and render the caption
    const captionMatch = latex.match(/\\caption{([\s\S]*?)}/);
    if (captionMatch) {
        const figcaption = document.createElement('figcaption');
        figcaption.className = 'rendered-table-caption';
        // Prepend "Table: " and then render content, which might include math.
        const captionText = `Table: ${captionMatch[1].trim()}`;
        renderCellContent(figcaption, captionText);
        container.appendChild(figcaption);
    }

    // Find and add a visual note for the label
    const labelMatch = latex.match(/\\label{([\s\S]*?)}/);
    if (labelMatch) {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'rendered-table-label-note';
        labelDiv.textContent = `(Label: ${labelMatch[1].trim()})`;
        container.appendChild(labelDiv);
    }

    if (!tabularMatch && !captionMatch && !labelMatch) {
        container.textContent = latex; // Fallback
    }

    return container;
}


// --- Helper: Append text with support for \\ as line breaks ---
function appendTextWithLineBreaks(container: HTMLElement, text: string) {
    const parts = text.split(/\\\\/g);
    parts.forEach((part, index) => {
        if (part) {
            container.appendChild(document.createTextNode(part));
        }
        if (index < parts.length - 1) {
            container.appendChild(document.createElement('br'));
        }
    });
}


// --- Constants and Configuration ---

const initialContent = `\\begin{align*}
  f(x) &= x^2 + 2x + 1 \\\\
       &= (x+1)^2
\\end{align*}

A table example with a caption:
\\begin{table}[h!]
  \\centering
  \\begin{tabular}{|l|c|r|}
    \\hline
    Left & Center & Right \\\\
    \\hline
    1 & $x^2$ & 3 \\\\
    4 & 5 & $\\alpha + \\beta$ \\\\
    \\hline
  \\end{tabular}
  \\caption{A table with a caption and math, like $\\sqrt{y}$.}
  \\label{tab:example}
\\end{table}

And some inline math: $\\sqrt{b^2 - 4ac}$.\\\\
This text appears on a new line.`;

const availablePackages = [
    'amsmath', 'amssymb', 'amsfonts', 'amsthm', 'babel', 'biblatex', 
    'caption', 'cleveref', 'enumitem', 'fancyhdr', 'fontenc', 'geometry', 
    'graphicx', 'hyperref', 'inputenc', 'microtype', 'siunitx', 'tikz', 
    'ulem', 'xcolor'
].sort();

const defaultPackages = ['amsmath', 'amssymb', 'amsfonts', 'xcolor', 'tikz', 'geometry', 'hyperref'];

const generateInitialPreamble = () => {
  let preamble = `\\documentclass{article}\n`;
  defaultPackages.forEach(pkg => {
    preamble += `\\usepackage{${pkg}}\n`;
  });
  if (defaultPackages.includes('geometry')) {
    preamble += `\\geometry{a4paper, margin=1in}\n`;
  }
  return preamble;
};
const initialPreamble = generateInitialPreamble();


const toolbarConfig = {
  'Editing': [
    { display: 'Undo', type: 'action', code: 'undo', ariaLabel: 'Undo last change' },
    { display: 'Redo', type: 'action', code: 'redo', ariaLabel: 'Redo last change' },
    { display: 'Search', type: 'action', code: 'find', ariaLabel: 'Find text (Ctrl+F)' },
    { display: 'Comment (%)', type: 'action', code: 'toggleComment', ariaLabel: 'Toggle comment (Ctrl+/)' },
  ],
  'Math': [
    {display: '$...$ - Inline', type: 'wrapper', code: '$', closing: '$'},
    {display: '\\(...\\) - Inline', type:'wrapper', code:'\\(', closing:'\\)'},
    {display: '$$...$$ - Display', type: 'wrapper', code: '$$\n  ', closing: '\n$$', multiline: true},
    {display: '\\[...\\] - Display', type:'wrapper', code:'\\[\n  ', closing:'\n\\]', multiline: true},
  ],
  'Formatting': [
    {display:'Bold', type:'wrapper', code:'\\textbf{', closing:'}'},
    {display:'Italic', type:'wrapper', code:'\\textit{', closing:'}'},
    {display:'Underline', type:'wrapper', code:'\\underline{', closing:'}'},
    {display:'Strike', type:'wrapper', code:'\\sout{', closing:'}'},
    {display:'x₂', type:'wrapper', code:'_{', closing:'}'},
    {display:'x²', type:'wrapper', code:'^{', closing:'}'},
    {display:'\\vec', type:'snippet', code:'\\vec{}', placeholder:'{}'},
    {display:'hat', type:'wrapper', code:'\\hat{', closing:'}'},
    {display:'bar', type:'wrapper', code:'\\bar{', closing:'}'},
    {display:'dot', type:'wrapper', code:'\\dot{', closing:'}'},
    {display:'ddot', type:'wrapper', code:'\\ddot{', closing:'}'},
    {display:'~', type:'wrapper', code:'\\tilde{', closing:'}'},
    {display:'overline', type:'wrapper', code:'\\overline{', closing:'}'},
    {display:'Color', type:'snippet', code:'\\textcolor{color}{text}', placeholder:'color'}
  ],
  'Environments':[
    {display:'align',type:'env',code:'align'},
    {display:'align*',type:'env',code:'align*'},
    {display:'equation',type:'env',code:'equation'},
    {display:'pmatrix',type:'env',code:'pmatrix'},
    {display:'bmatrix',type:'env',code:'bmatrix'},
    {display:'Vmatrix',type:'env',code:'Vmatrix'},
    {display:'vmatrix',type:'env',code:'vmatrix'},
    {display:'cases',type:'env',code:'cases'},
    {display:'bulletpoint', type:'env', code:'itemize'},
    {display:'numberlist', type:'env', code:'enumerate'},
  ],
  'Operators': [
    {display:'a/b', type:'snippet', code:'\\frac{}{}', placeholder:'{}'},
    {display:'√', type:'snippet', code:'\\sqrt{}', placeholder:'{}'},
    {display:'ⁿ√', type:'snippet', code:'\\sqrt[n]{}', placeholder:'{}'},
    {display:'∂', type:'insert', code:'\\partial '},
    {display:'Σ', type:'insert', code:'\\sum '},
    {display:'∫', type:'insert', code:'\\int '},
    {display:'lim', type:'insert', code:'\\lim_{n \\to \\infty} '},
    {display:'±', type:'insert', code:'\\pm '},
    {display:'·', type:'insert', code:'\\cdot '},
    {display:'×', type:'insert', code:'\\times '},
    {display:'÷', type:'insert', code:'\\div '},
    {display:'sin', type:'insert', code:'\\sin '},
    {display:'cos', type:'insert', code:'\\cos '},
    {display:'log', type:'insert', code:'\\log '},
    {display:'tan', type:'insert', code:'\\tan '},
    {display:'ln', type:'insert', code:'\\ln '},
    {display:'exp', type:'insert', code:'\\exp '},
    {display:'∞', type:'insert', code:'\\infty '},
    {display:'∇', type:'insert', code:'\\nabla '},
    {display:'…', type:'insert', code:'\\dots '},
    {display:'⋯', type:'insert', code:'\\cdots '},
    {display:'\\ldots', type:'insert', code:'\\ldots '},
    {display:'•', type:'insert', code:'\\bullet '},
    {display:'°', type:'insert', code:'\\circ '},
  ],
  'Greek Letters': [
    {display:'α', type:'insert', code:'\\alpha '},
    {display:'β', type:'insert', code:'\\beta '},
    {display:'γ', type:'insert', code:'\\gamma '},
    {display:'δ', type:'insert', code:'\\delta '},
    {display:'ε', type:'insert', code:'\\epsilon '},
    {display:'ζ', type:'insert', code:'\\zeta '},
    {display:'η', type:'insert', code:'\\eta '},
    {display:'θ', type:'insert', code:'\\theta '},
    {display:'π', type:'insert', code:'\\pi '},
    {display:'ω', type:'insert', code:'\\omega '},
    {display:'Γ', type:'insert', code:'\\Gamma '},
    {display:'Δ', type:'insert', code:'\\Delta '},
    {display:'Θ', type:'insert', code:'\\Theta '},
    {display:'Π', type:'insert', code:'\\Pi '},
    {display:'Ω', type:'insert', code:'\\Omega '},
  ],
  'Sets & Logic': [
    {display:'∈', type:'insert', code:'\\in '},
    {display:'∉', type:'insert', code:'\\notin '},
    {display:'⊂', type:'insert', code:'\\subset '},
    {display:'∪', type:'insert', code:'\\cup '},
    {display:'∩', type:'insert', code:'\\cap '},
    {display:'ℝ', type:'insert', code:'\\mathbb{R} '},
    {display:'∀', type:'insert', code:'\\forall '},
    {display:'∃', type:'insert', code:'\\exists '},
    {display:'¬', type:'insert', code:'\\neg '},
    {display:'∧', type:'insert', code:'\\land '},
    {display:'∨', type:'insert', code:'\\lor '},
    {display:'≈', type:'insert', code:'\\approx '},
    {display:'≠', type:'insert', code:'\\neq '},
    {display:'≤', type:'insert', code:'\\leq '},
    {display:'≥', type:'insert', code:'\\geq '},
    {display:'∅', type:'insert', code:'\\emptyset '},
    {display:'ℕ', type:'insert', code:'\\mathbb{N} '},
    {display:'ℤ', type:'insert', code:'\\mathbb{Z} '},
    {display:'ℚ', type:'insert', code:'\\mathbb{Q} '},
    {display:'ℂ', type:'insert', code:'\\mathbb{C} '},
    {display:'⟂', type:'insert', code:'\\perp'},
    {display:'∥', type:'insert', code:'\\parallel'},
  ],
  'Arrows': [
    {display:'→', type:'insert', code:'\\rightarrow '},
    {display:'←', type:'insert', code:'\\leftarrow '},
    {display:'↑', type:'insert', code:'\\uparrow '},
    {display:'↓', type:'insert', code:'\\downarrow '},
    {display:'⇒', type:'insert', code:'\\Rightarrow '},
    {display:'⇔', type:'insert', code:'\\Leftrightarrow '},
    {display:'↦', type:'insert', code:'\\mapsto '},
    {display:'⟹', type:'insert', code:'\\implies '},
    {display:'⟺', type:'insert', code:'\\iff '},
  ],
  'Delimiters': [
    {display:'()', type:'wrapper', code:'\\left( ', closing:' \\right)'},
    {display:'[]', type:'wrapper', code:'\\left[ ', closing:' \\right]'},
    {display:'{}', type:'wrapper', code:'\\left\\{ ', closing:' \\right\\}'},
    {display:'| |', type:'wrapper', code:'\\left| ', closing:' \\right|'},
    {display:'big', type:'insert', code:'\\big'},
    {display:'Big', type:'insert', code:'\\Big'},
    {display:'bigg', type:'insert', code:'\\bigg'},
    {display:'Bigg', type:'insert', code:'\\Bigg'},
    {display:'over brace', type:'insert', code:'\\overbrace{}'},
    {display:'under brace', type:'insert', code:'\\underbrace{}'}
  ],
  'Spacing': [
    {display:'Thin Spc', type:'insert', code:'\\,'},
    {display:'Thick Spc', type:'insert', code:'\\;'},
    {display:'Quad', type:'insert', code:'\\quad '},
    {display:'Dbl Quad', type:'insert', code:'\\qquad '},
    {display:'vspace', type:'insert', code:'\\vspace{x cm} '},
    {display:'hspace', type:'insert', code:'\\hspace{x cm} '},
    {display:'\\\\', type:'insert', code:'\\\\[x pt] '}
  ],
  'Units': [
    {display:'em (Relative)', type:'insert', code:'em'},
    {display:'ex (Relative)', type:'insert', code:'ex'},
    {display:'mu (Math)', type:'insert', code:'mu'},
    {display:'\\textwidth', type:'insert', code:'\\textwidth'},
    {display:'\\linewidth', type:'insert', code:'\\linewidth'},
    {display:'pt (Point)', type:'insert', code:'pt'},
    {display:'bp (Big Pt)', type:'insert', code:'bp'},
    {display:'in (Inch)', type:'insert', code:'in'},
    {display:'cm (Cm)', type:'insert', code:'cm'},
    {display:'mm (Mm)', type:'insert', code:'mm'},
    {display:'pc (Pica)', type:'insert', code:'pc'},
  ],
  'Document': [
    {display:'Section', type:'wrapper', code:'\\section{', closing:'}'},
    {display:'Subsection', type:'wrapper', code:'\\subsection{', closing:'}'},
    {display:'Subsubsection', type:'wrapper', code:'\\subsubsection{', closing:'}'},
    {display:'Paragraph', type:'wrapper', code:'\\paragraph{', closing:'}'},
    {display:'Subparagraph', type:'wrapper', code:'\\subparagraph{', closing:'}'},
    {display:'Title', type:'wrapper', code:'\\title{', closing:'}'},
    {display:'Author', type:'wrapper', code:'\\author{', closing:'}'},
    {display:'Date', type:'wrapper', code:'\\date{', closing:'}'},
    {display:'Abstract', type:'env', code:'abstract'},
  ],
  'References': [
    {display:'Link (href)', type:'snippet', code:'\\href{url}{text}', placeholder:'url', ariaLabel: 'Insert hyperlink'},
    {display:'Reference (ref)', type:'snippet', code:'\\ref{label}', placeholder:'label', ariaLabel: 'Insert cross-reference'},
    {display:'Citation (cite)', type:'snippet', code:'\\cite{key}', placeholder:'key', ariaLabel: 'Insert citation'},
  ],
  'Tables & Arrays': [
    {display:'array', type:'env', code:'array' },
    {display:'Table', type:'table', ariaLabel: 'Create table with custom size'},
    {display:'Cases (f(x))', type:'insert', code:'\\[\nf(x)=\n\\begin{cases}\n & \\\\\n & \n\\end{cases}\n\\]', ariaLabel: 'Insert cases environment with display math'},
    {display:'hline', type:'insert', code:'\\hline'}
  ],
  'Diagrams (TikZ)': [
    {display:'tikzpicture', type:'env', code:'tikzpicture'},
    {display:'Fill Shape', type:'wrapper', code:'\\fill[', closing:'] (0,0) rectangle (2,1);', ariaLabel: 'Insert a fill command with interactive options'},
    {display:'Draw Shape', type:'wrapper', code:'\\draw[', closing:'] (0,0) -- (2,1);', ariaLabel: 'Insert a draw command with interactive options'},
    {display:'Text Node', type:'snippet', code:'\\node at (x,y) {text};', placeholder:'(x,y)'},
    {display:'Circle', type:'insert', code:'\\draw (0,0) circle (1cm);'},
    {display:'Rectangle', type:'insert', code:'\\draw (0,0) rectangle (2,1);'},
    {display:'Ellipse', type:'insert', code:'\\draw (0,0) ellipse (2cm and 1cm);'},
    {display:'Triangle', type:'insert', code:'\\draw (0,0) -- (1,2) -- (2,0) -- cycle;'},
    {display:'Angle ∡', type:'insert', code:'\\draw pic["$\\theta$", draw=black, angle radius=9mm] {angle = B--A--C};'},
    {display:'Right Angle ∟', type:'insert', code:'\\draw pic["$\\theta$", draw=black, angle radius=9mm] {right angle = B--A--C};'}
  ]
};


// --- Helper Functions ---
const documentClassInfo = {
  commonOptions: {
    '10pt': 'Sets base font size to 10pt.',
    '11pt': 'Sets base font size to 11pt.',
    '12pt': 'Sets base font size to 12pt.',
    'a4paper': 'Use A4 paper size.',
    'letterpaper': 'Use US Letter paper size.',
    'legalpaper': 'Use US Legal paper size.',
    'twocolumn': 'Typeset in two columns.',
    'landscape': 'Use landscape orientation.',
    'oneside': 'Format for one-sided printing.',
    'twoside': 'Format for two-sided printing.',
    'fleqn': 'Display equations flushed to the left.',
    'leqno': 'Place equation numbers on the left.',
  },
  classes: {
    article: {
      description: 'For articles, short reports, documentation.',
      options: {}
    },
    book: {
      description: 'For books with chapters.',
      options: {
        'openright': 'Chapters start on a right-hand page.',
        'openany': 'Chapters start on any next page.',
        'chapterprefix': 'Prefix chapter numbers with "Chapter".',
        'nochapterprefix': 'No prefix for chapter numbers.',
      }
    },
    report: {
      description: 'For longer reports with chapters.',
      options: {
        'openright': 'Chapters start on a right-hand page.',
        'openany': 'Chapters start on any next page.',
        'chapterprefix': 'Prefix chapter numbers with "Chapter".',
        'nochapterprefix': 'No prefix for chapter numbers.',
      }
    },
    standalone: {
      description: 'Creates cropped PDFs for graphics.',
      options: {
        'tikz': 'Load the TikZ package for diagrams.',
        'preview': 'Generate a preview image.',
        'border=5pt': 'Add a 5pt border around content.',
        'crop': 'Crop output to content size.'
      }
    },
    letter: {
      description: 'For writing letters.',
      options: {}
    },
    beamer: {
      description: 'For creating presentations (slides).',
      options: {
        'aspectratio=169': 'Set aspect ratio to 16:9.',
        'handout': 'Generate a handout version for printing.',
        'compress': 'Compress navigation bars.',
        't': 'Align frame content to the top.',
        'c': 'Align frame content to the center (default).',
        'b': 'Align frame content to the bottom.',
        'smaller': 'Use a smaller font size for frame content.',
        'professionalfonts': 'Use professional fonts (e.g., Computer Modern).',
        'ignorenonframetext': 'Ignore any text outside of frame environments.'
      }
    },
    memoir: {
      description: 'A versatile class for books, reports, and articles.',
      options: {
        'extrafontsizes': 'Provides more font size commands.',
        'draft': 'Marks document as a draft (shows overfull boxes).',
        'final': 'Marks document as final (hides draft marks).'
      }
    }
  },
  classNames: ['article', 'book', 'report', 'standalone', 'letter', 'beamer', 'memoir']
};

const packageOptionsInfo = {
  geometry: {
    description: 'Control page layout and margins.',
    options: {
      'a4paper': 'Use A4 paper size.',
      'letterpaper': 'Use US Letter paper size.',
      'margin=1in': 'Set all margins to 1 inch.',
      'landscape': 'Use landscape orientation.',
      'twoside': 'Format for two-sided printing.',
      'includehead': 'Include header in text height.',
      'includefoot': 'Include footer in text height.',
      'headheight=15pt': 'Set header height.',
      'bindingoffset=': 'Add offset for binding.',
      'heightrounded': 'Adjust text height to an integer number of lines.',
      'total={width,height}': 'Specify total page dimensions.',
      'top=1in': 'Set top margin.',
      'bottom=1in': 'Set bottom margin.',
      'left=1in': 'Set left margin.',
      'right=1in': 'Set right margin.',
    }
  },
  inputenc: {
    description: 'Specify input encoding.',
    options: {
      'utf8': 'Unicode UTF-8 encoding (recommended).',
      'latin1': 'ISO 8859-1 encoding.',
      'ascii': 'Basic ASCII encoding.',
    }
  },
  fontenc: {
    description: 'Specify font encoding.',
    options: {
      'T1': 'T1 font encoding (for accented characters).',
      'OT1': 'Original TeX font encoding.',
    }
  },
  babel: {
    description: 'Provide language-specific typography.',
    options: {
      'english': 'Load hyphenation patterns for English.',
      'french': 'Load hyphenation patterns for French.',
      'german': 'Load hyphenation patterns for German.',
      'spanish': 'Load hyphenation patterns for Spanish.',
      'main=english': 'Set the main document language.',
    }
  },
  hyperref: {
    description: 'Create hyperlinks within the document.',
    options: {
      'colorlinks=true': 'Color links instead of using boxes.',
      'linkcolor=blue': 'Set color of internal links.',
      'citecolor=green': 'Set color of citation links.',
      'urlcolor=magenta': 'Set color of URL links.',
      'pdfauthor=': 'Set the PDF author metadata.',
      'pdftitle=': 'Set the PDF title metadata.',
      'pdfkeywords=': 'Set the PDF keywords metadata.',
      'hidelinks': 'Hide link borders and colors.',
      'bookmarks=true': 'Create PDF bookmarks.',
      'breaklinks=true': 'Allow links to wrap across lines.',
      'pdfencoding=auto': 'Automatically determine PDF string encoding.',
      'pdfstartview=Fit': 'Set the initial PDF view to fit the page.',
    }
  },
  caption: {
    description: 'Customize captions in floating environments.',
    options: {
      'font=small': 'Use a smaller font for captions.',
      'labelfont=bf': 'Use a bold font for the label (e.g., "Figure 1").',
      'justification=centering': 'Center-align the caption text.',
      'justification=raggedright': 'Left-align the caption text.',
      'justification=justified': 'Justify the caption text.',
    }
  },
  biblatex: {
    description: 'Advanced bibliography management.',
    options: {
      'backend=biber': 'Use Biber backend (recommended).',
      'backend=bibtex': 'Use BibTeX backend.',
      'style=apa': 'Use APA citation style.',
      'style=numeric': 'Use numeric citation style.',
      'style=authoryear': 'Use author-year citation style.',
      'sorting=ynt': 'Sort by year, name, title.',
      'sorting=none': 'Do not sort; use citation order.',
    }
  },
  xcolor: {
    description: 'Provides color support.',
    options: {
      'table': 'Load color for table cells.',
      'dvipsnames': 'Load the dvips color name set.',
      'svgnames': 'Load the SVG color name set.',
      'x11names': 'Load the X11 color name set.',
    }
  },
  siunitx: {
    description: 'Typesetting for physical quantities, units, and numbers.',
    options: {
      'detect-all=true': 'Detect and apply font settings from surrounding text.',
      'locale=': 'Set the locale for number formatting (e.g., locale=US).',
    }
  }
};

// --- TikZ Autocomplete Options ---
const tikzOptions = {
    // Colors
    'red': 'Sets the color to red.',
    'blue': 'Sets the color to blue.',
    'green': 'Sets the color to green.',
    'yellow': 'Sets the color to yellow.',
    'orange': 'Sets the color to orange.',
    'purple': 'Sets the color to purple.',
    'black': 'Sets the color to black.',
    'white': 'Sets the color to white.',
    'gray': 'Sets the color to gray.',
    'cyan': 'Sets the color to cyan.',
    'magenta': 'Sets the color to magenta.',
    'blue!50': 'A 50% tint of blue.',
    'green!70!black': 'A 70% green, 30% black mix.',
    // Opacity
    'opacity=': 'Sets fill & stroke opacity (e.g., opacity=0.5)',
    'fill opacity=': 'Sets fill opacity (e.g., fill opacity=0.4)',
    'draw opacity=': 'Sets stroke opacity (e.g., draw opacity=0.7)',
    // Line styles
    'draw=': 'Sets stroke color (e.g., draw=black)',
    'thick': 'A thick line.',
    'ultra thick': 'An ultra thick line.',
    'thin': 'A thin line.',
    'dashed': 'A dashed line pattern.',
    'dotted': 'A dotted line pattern.',
    'dash dot': 'A dash-dot line pattern.',
    // Line style modifiers (with sub-options)
    'densely': {
        description: 'Apply a dense pattern to a line style.',
        subOptions: {
            'dashed': 'A densely dashed line.',
            'dotted': 'A densely dotted line.',
            'dash dot': 'A densely dash-dot line.'
        }
    },
    'loosely': {
        description: 'Apply a loose pattern to a line style.',
        subOptions: {
            'dashed': 'A loosely dashed line.',
            'dotted': 'A loosely dotted line.',
            'dash dot': 'A loosely dash-dot line.'
        }
    },
    // Patterns (with sub-options)
    'pattern=': {
        description: 'Fill with a pattern. Needs \\usetikzlibrary{patterns}.',
        subOptions: {
            'north west lines': 'Diagonal lines pattern.',
            'crosshatch': 'Crosshatch pattern.',
            'checkerboard': 'Checkerboard pattern.',
            'dots': 'Dots pattern.'
        }
    },
    'pattern color=': 'Sets pattern color (e.g., pattern color=blue)',
    // Shading
    'shading=': {
        description: 'Sets shading style. Needs \\usetikzlibrary{shadings}.',
        subOptions: {
            'axis': 'Axial shading.',
            'radial': 'Radial shading.',
        }
    },
    'left color=': 'Sets the left color for axial shading (e.g., left color=red).',
    'right color=': 'Sets the right color for axial shading (e.g., right color=blue).',
    'top color=': 'Sets the top color for axial shading (e.g., top color=yellow).',
    'bottom color=': 'Sets the bottom color for axial shading (e.g., bottom color=green).',
    'middle color=': 'Sets the middle color for shading (e.g., middle color=white).',
};

const latexHint = (cm, options) => {
  const cur = cm.getCursor();
  const line = cm.getLine(cur.line);
  const lineToCursor = line.slice(0, cur.ch);

  // Case for TikZ options in \fill[...] or \draw[...]
  const tikzMatch = lineToCursor.match(/\\(fill|draw)\[([^\]]*)$/);
  if (tikzMatch) {
    const typedPart = tikzMatch[2];
    const currentTypedOptions = typedPart.split(',');
    const currentOptionPrefix = (currentTypedOptions.pop() || '').trim();
    
    // Use a regex to get the base option name, e.g., 'densely' from 'densely dashed'
    const usedOptions = new Set(currentTypedOptions.map(s => s.trim().split(/=|\s/)[0]));

    // Check for sub-options like 'densely dashed' or 'pattern=dots'
    const subOptionMatch = currentOptionPrefix.match(/^(densely|loosely|pattern=|shading=)\s*(.*)$/);
    if (subOptionMatch) {
        const mainOptRaw = subOptionMatch[1];
        const subOptPrefix = subOptionMatch[2].trim();
        const mainOptKey = mainOptRaw.endsWith('=') ? mainOptRaw : mainOptRaw.trim();
        
        const mainOptionConfig = tikzOptions[mainOptKey];
        
        if (mainOptionConfig && typeof mainOptionConfig === 'object' && mainOptionConfig.subOptions) {
            const subOptions = mainOptionConfig.subOptions;
            const suggestions = Object.entries(subOptions)
                .filter(([opt]) => opt.startsWith(subOptPrefix))
                .map(([opt, desc]) => {
                    const fullText = mainOptKey.endsWith('=') ? `${mainOptKey}${opt}` : `${mainOptKey} ${opt}`;
                    return {
                        text: fullText,
                        displayText: `${fullText.padEnd(30, ' ')} ${desc}`
                    };
                });

            if (suggestions.length > 0) {
                return {
                    list: suggestions,
                    from: CodeMirror.Pos(cur.line, cur.ch - currentOptionPrefix.length),
                    to: CodeMirror.Pos(cur.line, cur.ch),
                };
            }
        }
    }

    const suggestions = Object.entries(tikzOptions)
      .filter(([opt]) => opt.startsWith(currentOptionPrefix) && !usedOptions.has(opt.split(/=|\s/)[0]))
      .map(([opt, info]) => {
          const desc = typeof info === 'string' ? info : info.description;
          // FIX: Add a type annotation to 'completion' to allow for the optional 'hint' property, resolving the TypeScript error.
          const completion: { text: string; displayText: string; hint?: (cm: any, data: any, comp: any) => void; } = {
              text: opt,
              displayText: `${opt.padEnd(30, ' ')} ${desc}`
          };
          
          if (typeof info === 'object' && info.subOptions) {
              const textToInsert = opt.endsWith('=') ? opt : opt + ' ';
              completion.text = textToInsert; // Use this text for insertion
              completion.hint = (cm, data, comp) => {
                  cm.replaceRange(textToInsert, data.from, data.to);
                  const newCursorPos = { line: data.from.line, ch: data.from.ch + textToInsert.length };
                  cm.setCursor(newCursorPos);
                  // Trigger hints again for sub-options
                  setTimeout(() => cm.showHint({ completeSingle: false }), 50);
              };
          } else if (opt.endsWith('=')) {
              completion.hint = (cm, data, comp) => {
                  cm.replaceRange(comp.text, data.from, data.to);
                  const newCursorPos = { line: data.from.line, ch: data.from.ch + comp.text.length };
                  cm.setCursor(newCursorPos);
              };
          }
          return completion;
      });
      
    if (suggestions.length > 0) {
      return {
        list: suggestions,
        from: CodeMirror.Pos(cur.line, cur.ch - currentOptionPrefix.length),
        to: CodeMirror.Pos(cur.line, cur.ch),
      };
    }
  }
  
  // Case 1: \documentclass[...<CURSOR>...] - Autocomplete options
  const docClassOptionsMatch = lineToCursor.match(/.*\\documentclass\[([^\]]*)$/);
  if (docClassOptionsMatch) {
    // Find the class used on this line to suggest relevant options
    const classOnLineMatch = line.match(/\{([\w-]+)\}/);
    const className = classOnLineMatch ? classOnLineMatch[1] : null;

    const typedPart = docClassOptionsMatch[1];
    const typedOptions = typedPart.split(',').map(s => s.trim().split('=')[0]); // Handle key=value
    const currentOptionPrefix = typedOptions.pop() || '';

    const availableOptions = { ...documentClassInfo.commonOptions };
    if (className && documentClassInfo.classes[className]) {
      Object.assign(availableOptions, documentClassInfo.classes[className].options);
      // Special handling for memoir inheritance
      if (className === 'memoir') {
        Object.assign(availableOptions, documentClassInfo.classes.book.options);
        Object.assign(availableOptions, documentClassInfo.classes.report.options);
      }
    }

    const usedOptions = new Set(typedOptions);
    const suggestions = Object.entries(availableOptions)
      .filter(([opt]) => opt.startsWith(currentOptionPrefix) && !usedOptions.has(opt.split('=')[0]))
      .map(([opt, desc]) => ({
        text: opt,
        displayText: `${opt.padEnd(22, ' ')} ${desc}`
      }));

    if (suggestions.length > 0) {
      return {
        list: suggestions,
        from: CodeMirror.Pos(cur.line, cur.ch - currentOptionPrefix.length),
        to: CodeMirror.Pos(cur.line, cur.ch),
      };
    }
  }

  // Case 2: \usepackage[...<CURSOR>...] - Autocomplete package options
  const usePackageOptionsMatch = lineToCursor.match(/.*\\usepackage\[([^\]]*)$/);
  if (usePackageOptionsMatch) {
    const packageOnLineMatch = line.match(/\{([\w-]+)\}/);
    const packageName = packageOnLineMatch ? packageOnLineMatch[1] : null;
    
    if (packageName && packageOptionsInfo[packageName]) {
      const typedPart = usePackageOptionsMatch[1];
      const typedOptions = typedPart.split(',').map(s => s.trim().split('=')[0]);
      const currentOptionPrefix = typedOptions.pop() || '';
      
      const availableOptions = packageOptionsInfo[packageName].options;
      const usedOptions = new Set(typedOptions);

      const suggestions = Object.entries(availableOptions)
        .filter(([opt]) => opt.startsWith(currentOptionPrefix) && !usedOptions.has(opt.split('=')[0]))
        .map(([opt, desc]) => ({
          text: opt,
          displayText: `${opt.padEnd(25, ' ')} ${desc}`
        }));
        
      if (suggestions.length > 0) {
        return {
          list: suggestions,
          from: CodeMirror.Pos(cur.line, cur.ch - currentOptionPrefix.length),
          to: CodeMirror.Pos(cur.line, cur.ch),
        };
      }
    }
  }

  // Case 3: \documentclass{...<CURSOR>...} - Autocomplete class names
  const docClassMatch = lineToCursor.match(/.*\\documentclass(?:\[[^\]]*\])?\{([\w-]*)$/);
  if (docClassMatch) {
    const typedPrefix = docClassMatch[1];
    const suggestions = documentClassInfo.classNames
      .filter(name => name.startsWith(typedPrefix))
      .map(name => ({
        text: name,
        displayText: `${name.padEnd(12, ' ')} ${documentClassInfo.classes[name].description}`
      }));

    if (suggestions.length > 0) {
      return {
        list: suggestions,
        from: CodeMirror.Pos(cur.line, cur.ch - typedPrefix.length),
        to: CodeMirror.Pos(cur.line, cur.ch),
      };
    }
  }

  // Case 4: \usepackage{...<CURSOR>...} - Autocomplete package names
  const packageMatch = lineToCursor.match(/.*\\usepackage(?:\[[^\]]*\])?\{([\w-]*)$/);
  if (packageMatch) {
    const typedPrefix = packageMatch[1];
    
    const preambleContent = cm.getValue();
    const usedPackagesMatches = preambleContent.match(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g) || [];
    const usedPackages = new Set();
    usedPackagesMatches.forEach(m => {
        const pkgMatch = m.match(/\{([^}]+)\}/);
        if (pkgMatch && pkgMatch[1]) {
            pkgMatch[1].split(',').forEach(pkg => usedPackages.add(pkg.trim()));
        }
    });

    const suggestions = availablePackages.filter(pkg => 
      pkg.startsWith(typedPrefix) && !usedPackages.has(pkg)
    );

    return {
      list: suggestions,
      from: CodeMirror.Pos(cur.line, cur.ch - typedPrefix.length),
      to: CodeMirror.Pos(cur.line, cur.ch),
    };
  }

  // Case 5: \<COMMAND><CURSOR> - Autocomplete command names
  const commandMatch = lineToCursor.match(/\\(\w*)$/);
  if (commandMatch) {
    const typedCommand = commandMatch[1];
    const suggestions = [];

    if ('usepackage'.startsWith(typedCommand) && typedCommand.length > 0) {
      suggestions.push({
        text: '\\usepackage{}',
        displayText: '\\usepackage{}',
        hint: (cm, data, completion) => {
          const from = data.from;
          const to = data.to;
          cm.replaceRange('\\usepackage{}', from, to);
          cm.setCursor({ line: from.line, ch: from.ch + '\\usepackage{'.length });
        }
      });
      suggestions.push({
        text: '\\usepackage[]{}',
        displayText: '\\usepackage[options]{package}',
        hint: (cm, data, completion) => {
            const from = data.from;
            const to = data.to;
            cm.replaceRange('\\usepackage[]{}', from, to);
            cm.setCursor({ line: from.line, ch: from.ch + '\\usepackage['.length });
        }
      });
    }

    if ('documentclass'.startsWith(typedCommand) && typedCommand.length > 0) {
      suggestions.push({
        text: '\\documentclass[]{}',
        displayText: '\\documentclass[options]{class}',
        hint: (cm, data, completion) => {
          const from = data.from;
          const to = data.to;
          cm.replaceRange('\\documentclass[]{}', from, to);
          // Position cursor inside the square brackets for options
          cm.setCursor({ line: from.line, ch: from.ch + '\\documentclass['.length });
        }
      });
    }
    
    if (suggestions.length > 0) {
      return {
        list: suggestions,
        from: CodeMirror.Pos(cur.line, cur.ch - typedCommand.length - 1), // Start from the backslash
        to: CodeMirror.Pos(cur.line, cur.ch)
      };
    }
  }

  return null;
};


function handleEnter(cm: any) {
  const doc = cm.getDoc();
  const cur = doc.getCursor();
  const line = doc.getLine(cur.line);

  // The autocompletion for \begin{...} should only trigger if the cursor is at the very end of the line.
  // This prevents accidentally replacing text if Enter is pressed with the cursor elsewhere on the line.
  const beginMatch = line.match(/\\begin\{([a-zA-Z*]+)\}\s*$/);
  if (beginMatch && cur.ch === line.length) {
    const env = beginMatch[1];
    const currentIndent = line.match(/^\s*/)[0];
    const newIndent = currentIndent + '  ';
    const insertText = `\n${newIndent}\n${currentIndent}\\end{${env}}`;
    
    // Use replaceSelection to avoid replacing parts of the line by mistake
    cm.replaceSelection(insertText);
    
    // Move cursor to the newly created indented line
    cm.setCursor({ line: cur.line + 1, ch: newIndent.length });
    return; // Prevent default Enter action
  }

  // For all other cases, perform the default Enter action
  return CodeMirror.Pass;
}

// --- Components ---

const Toolbar = ({ editorInstance, onItemClick, onTableClick }) => {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const dropdownCategories = [
    'Editing',
    'Math',
    'Formatting',
    'Environments',
    'Delimiters',
    'Document',
    'References',
    'Operators',
    'Greek Letters',
    'Sets & Logic',
    'Arrows',
    'Spacing',
    'Units',
    'Tables & Arrays',
    'Diagrams (TikZ)',
  ];

  const handleToolbarClick = useCallback((item) => {
    if (item.type === 'table') {
        onTableClick?.();
        return;
    }
    onItemClick?.(item); // Notify parent component about the click
    
    if (!editorInstance) return;

    const editor = editorInstance;
    const doc = editor.getDoc();
    const sel = doc.getSelection();
    const cur = doc.getCursor();
    editor.focus();

    if (item.type === 'wrapper') {
      // Special handling for multiline wrappers (like display math) when no text is selected
      if (item.multiline && !sel) {
          const snippet = item.code + item.closing;
          doc.replaceRange(snippet, cur);
          // Position cursor in the middle, indented
          doc.setCursor({ line: cur.line + 1, ch: 2 });
      } else {
          doc.replaceSelection(item.code + (sel || '') + item.closing);
          if (!sel) {
            const newCursorPos = { line: cur.line, ch: cur.ch + item.code.length };
            doc.setCursor(newCursorPos);
            // If the item is one of our special TikZ commands, show the hint dropdown
            if (item.display === 'Fill Shape' || item.display === 'Draw Shape') {
                setTimeout(() => editor.showHint({ completeSingle: false }), 50);
            }
          }
      }
    } else if (item.type === 'snippet') {
      const snippet = item.code;
      const placeholder = item.placeholder || '';
      doc.replaceSelection(snippet);
      const placeholderIndex = placeholder ? snippet.indexOf(placeholder) : -1;
      if (placeholderIndex !== -1) {
        const from = { line: cur.line, ch: cur.ch + placeholderIndex };
        const to = { line: cur.line, ch: from.ch + placeholder.length };
        doc.setSelection(from, to);
      }
    } else if (item.type === 'env') {
      handleItem(item, doc);
    } else if (item.type === 'action') {
        editor.execCommand(item.code);
    } else { // 'insert' type
      doc.replaceSelection(item.code);
    }
  }, [editorInstance, onItemClick, onTableClick]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const toggleDropdown = (group: string) => {
    setOpenDropdown(openDropdown === group ? null : group);
  };


  return (
    <div id="toolbar" ref={toolbarRef}>
      {Object.entries(toolbarConfig).map(([group, items]) => {
        if (dropdownCategories.includes(group)) {
          return (
            <div className="toolbar-dropdown" key={group}>
              <button
                className="toolbar-dropdown-toggle"
                onClick={() => toggleDropdown(group)}
                aria-haspopup="true"
                aria-expanded={openDropdown === group}
              >
                {group}
              </button>
              {openDropdown === group && (
                <div className="toolbar-dropdown-menu">
                  {items.map((item) => (
                    <button
                      className="symbol-btn"
                      key={item.display}
                      onClick={() => {
                        handleToolbarClick(item);
                        setOpenDropdown(null); // Close on selection
                      }}
                      aria-label={item.ariaLabel || `Insert ${item.display}`}
                    >
                      {item.display}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        } else {
          return (
            <div className="toolbar-group" key={group}>
              <div className="toolbar-group-title">{group}</div>
              <div className="toolbar-buttons">
                {items.map((item) => (
                  <button className="symbol-btn" key={item.display} onClick={() => handleToolbarClick(item)} aria-label={item.ariaLabel || `Insert ${item.display}`}>
                    {item.display}
                  </button>
                ))}
              </div>
            </div>
          );
        }
      })}
    </div>
  );
};

interface EditorProps {
    value?: string;
    onChange?: (value: string) => void;
    options?: any;
    setInstance?: (editor: any) => void;
}

const Editor = ({ value, onChange, options = {}, setInstance = () => {} }: EditorProps) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const editorRef = useRef(null);
    
    const extraKeys = {
      'Cmd-/': 'toggleComment',
      'Ctrl-/': 'toggleComment',
      'Cmd-F': 'find',
      'Ctrl-F': 'find',
      'Cmd-G': 'findNext',
      'Ctrl-G': 'findNext',
      'Shift-Cmd-G': 'findPrev',
      'Shift-Ctrl-G': 'findPrev',
      'Cmd-Alt-F': 'replace',
      'Ctrl-Alt-F': 'replace',
      'Shift-Cmd-Alt-F': 'replaceAll',
      'Shift-Ctrl-Alt-F': 'replaceAll',
      'Ctrl-Space': 'autocomplete',
      'Tab': (cm) => { if(cm.somethingSelected()) {cm.execCommand('indentMore');} else {cm.replaceSelection('  ');} },
      'Enter': handleEnter
    };

    useEffect(() => {
        if (!textareaRef.current) return;
        const editor = CodeMirror.fromTextArea(textareaRef.current, {
            mode: 'stex',
            lineNumbers: true,
            autoCloseBrackets: true,
            matchBrackets: true,
            indentUnit: 2,
            tabSize: 2,
            indentWithTabs: false,
            extraKeys: extraKeys,
            ...options
        });
        editorRef.current = editor;
        setInstance?.(editor);
        editor.setValue(value ?? '');
        
        const handleChange = (instance) => {
            onChange?.(instance.getValue());
        };
        editor.on('change', handleChange);

        if (options.hintOptions?.hint) {
            editor.on('inputRead', (cm, change) => {
                if (change.origin !== '+delete' && !/^[}\],]$/.test(change.text[0])) {
                    cm.showHint({ completeSingle: false });
                }
            });

            const cursorHandler = (cm) => {
                if (cm.state.completionActive || cm.somethingSelected()) return;
                
                const cur = cm.getCursor();
                const line = cm.getLine(cur.line);
                const lineToCursor = line.slice(0, cur.ch);

                const inDocClassOptions = /.*\\documentclass\[[^\]]*$/.test(lineToCursor);
                const inDocClassBraces = /.*\\documentclass(?:\[[^\]]*\])?\{[\w-]*$/.test(lineToCursor);
                const inPackageBraces = /.*\\usepackage(?:\[[^\]]*\])?\{[\w-]*$/.test(lineToCursor);
                const inUsePackageOptions = /.*\\usepackage\[[^\]]*$/.test(lineToCursor);
                const inTikzOptions = /\\(fill|draw)\[[^\]]*$/.test(lineToCursor);

                if (inDocClassOptions || inDocClassBraces || inPackageBraces || inUsePackageOptions || inTikzOptions) {
                    setTimeout(() => {
                        if (!cm.state.completionActive) {
                            cm.showHint({ completeSingle: false });
                        }
                    }, 50);
                }
            };
            editor.on('cursorActivity', cursorHandler);
        }

        return () => { editor.toTextArea(); };
    }, []);

    useEffect(() => {
        const editor = editorRef.current;
        if (editor && editor.getValue() !== value) {
            const cursor = editor.getCursor();
            editor.setValue(value);
            editor.setCursor(cursor);
        }
    }, [value]);

    return <textarea ref={textareaRef} />;
};

const Preview = ({ content, onSyncClick }: { content: string; onSyncClick: (pos: {start: number; end: number}) => void }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState(null);

    const handlePreviewClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      let target = e.target as HTMLElement;
      while (target && target !== previewRef.current) {
        if (target.dataset.sourcePosition) {
          try {
            const pos = JSON.parse(target.dataset.sourcePosition);
            if (pos && typeof pos.start === 'number' && typeof pos.end === 'number') {
              onSyncClick(pos);
            }
            return;
          } catch (err) {
            console.error("Failed to parse source position:", err);
            return;
          }
        }
        target = target.parentElement;
      }
    }, [onSyncClick]);

    useEffect(() => {
        const previewNode = previewRef.current;
        if (!previewNode || typeof katex === 'undefined') return;
        
        previewNode.innerHTML = '';
        setError(null);
        let hasError = false;

        const regex = /(\\begin{table}[\s\S]*?\\end{table})|(\\begin{tabular}[\s\S]*?\\end{tabular})|(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\begin{(align|align\*|equation|pmatrix|bmatrix|Vmatrix|vmatrix|cases)}[\s\S]*?\\end{\4}|\$(?:\\.|[^$])*?\$|\\\((?:\\.|[^)])*?\\\))/g;

        let lastIndex = 0;
        let match;

        while ((match = regex.exec(content)) !== null) {
            if (match.index > lastIndex) {
                appendTextWithLineBreaks(previewNode, content.substring(lastIndex, match.index));
            }
            
            const fragment = match[0];
            const fragmentStartIndex = match.index;
            const fragmentEndIndex = fragmentStartIndex + fragment.length;
            
            if (match[1]) { // It's a table environment
                const tableNode = renderTableEnvironment(fragment);
                tableNode.dataset.sourcePosition = JSON.stringify({ start: fragmentStartIndex, end: fragmentEndIndex });
                previewNode.appendChild(tableNode);

            } else if (match[2]) { // It's a standalone tabular environment
                const tableNode = renderTabular(fragment);
                tableNode.dataset.sourcePosition = JSON.stringify({ start: fragmentStartIndex, end: fragmentEndIndex });
                previewNode.appendChild(tableNode);

            } else if (match[3]) { // It's a KaTeX-renderable block
                let isDisplay;
                let mathContent;

                if (fragment.startsWith('$$') || fragment.startsWith('\\[')) {
                    isDisplay = true;
                    mathContent = fragment.slice(2, -2);
                } else if (fragment.startsWith('\\begin')) {
                    isDisplay = true;
                    mathContent = fragment; // For environments, KaTeX expects the full environment block.
                } else { // Inline math: $...$ or \(...\)
                    isDisplay = false;
                    const startSlice = fragment.startsWith('\\(') ? 2 : 1;
                    const endSlice = fragment.endsWith('\\)') ? -2 : -1;
                    mathContent = fragment.slice(startSlice, endSlice);
                }

                try {
                    const mathHtml = katex.renderToString(mathContent, {
                        displayMode: isDisplay,
                        throwOnError: true,
                        macros: { "\\vec": "\\mathbf{#1}", "\\mathbb": "\\mathbf" }
                    });
                    const wrapper = document.createElement(isDisplay ? 'div' : 'span');
                    wrapper.innerHTML = mathHtml;
                    wrapper.dataset.sourcePosition = JSON.stringify({ start: fragmentStartIndex, end: fragmentEndIndex });
                    previewNode.appendChild(wrapper);
                } catch (e) {
                    if (!hasError) {
                        setError(e.message.replace('KaTeX parse error: ', ''));
                        hasError = true;
                    }
                    const errorSpan = document.createElement('span');
                    errorSpan.className = 'katex-error-inline';
                    errorSpan.textContent = fragment;
                    errorSpan.title = e.message.replace('KaTeX parse error: ', '');
                    errorSpan.dataset.sourcePosition = JSON.stringify({ start: fragmentStartIndex, end: fragmentEndIndex });
                    previewNode.appendChild(errorSpan);
                }
            }
            lastIndex = fragmentEndIndex;
        }
        if (lastIndex < content.length) {
             appendTextWithLineBreaks(previewNode, content.substring(lastIndex));
        }
    }, [content]);

    return (
        <div id="preview">
            <h2>Preview</h2>
            {error && (
                <div id="preview-error" role="alert">
                  <strong>Error:</strong> {error}
                </div>
            )}
            <div id="preview-content" ref={previewRef} aria-live="polite" onClick={handlePreviewClick}></div>
        </div>
    );
};

const Resizer = ({ onDrag }) => {
  const handleMouseDown = (e) => {
    e.preventDefault();
    const handleMouseMove = (event) => {
      onDrag(event.clientX);
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return <div className="resizer" onMouseDown={handleMouseDown}></div>;
};

const generateTableLatex = (rows: number, cols: number): string => {
  const numRows = Math.max(1, rows);
  const numCols = Math.max(1, cols);

  const columnFormat = Array(numCols).fill('c').join('');
  
  const rowCells = Array(numCols).fill(' ').join(' & '); // Creates " &  & " for 3 cols
  
  const tableBody = Array(numRows).fill(rowCells).join(' \\\\\n        ');

  return `\\begin{table}[h!]
    \\centering
    \\begin{tabular}{${columnFormat}}
        ${tableBody}
    \\end{tabular}
    \\caption{Caption}
    \\label{tab:my_label}
\\end{table}`;
};

const TableCreatorModal = ({ onClose, onCreate }: { onClose: () => void, onCreate: (rows: number, cols: number) => void }) => {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const modalRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);
  
  const handleCreate = () => {
    if (rows > 0 && cols > 0) {
      onCreate(rows, cols);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="table-modal-title">
        <div className="modal-header">
          <h3 id="table-modal-title">Create Table</h3>
          <button onClick={onClose} className="modal-close-btn" aria-label="Close">&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label htmlFor="table-rows">Rows</label>
            <input
              id="table-rows"
              type="number"
              min="1"
              value={rows}
              onChange={(e) => setRows(parseInt(e.target.value, 10) || 1)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="table-cols">Columns</label>
            <input
              id="table-cols"
              type="number"
              min="1"
              value={cols}
              onChange={(e) => setCols(parseInt(e.target.value, 10) || 1)}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="action-btn clear-btn">Cancel</button>
          <button onClick={handleCreate} className="action-btn download-btn">Create</button>
        </div>
      </div>
    </div>
  );
};


const App = () => {
  const [preamble, setPreamble] = useState(initialPreamble);
  const [content, setContent] = useState(initialContent);
  const [debouncedContent, setDebouncedContent] = useState(content);
  const [contentEditorInstance, setContentEditorInstance] = useState(null);
  const [isTableModalOpen, setTableModalOpen] = useState(false);
  const [autoCompile, setAutoCompile] = useState(true);
  const [leftPanelWidth, setLeftPanelWidth] = useState(55);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const aiPromptRef = useRef<HTMLTextAreaElement>(null);

  const handleSendToAI = async () => {
    if (!aiPrompt.trim() || isGenerating) return;
    setIsGenerating(true);
    setAiError(null);

    const isPreambleRequest = /@preamble|\bpreamble\b/i.test(aiPrompt);
    const cleanedPrompt = aiPrompt.replace(/@preamble/ig, '').trim();

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        let fullPrompt: string;
        let systemInstruction: string;
        let targetUpdater: React.Dispatch<React.SetStateAction<string>>;

        if (isPreambleRequest) {
            targetUpdater = setPreamble;
            systemInstruction = "You are a helpful LaTeX editor assistant. You will be given the user's current LaTeX preamble and a prompt describing changes. Your task is to return the complete, modified LaTeX preamble. ONLY output the raw LaTeX code, without any markdown, explanations, or ```latex formatting.";
            fullPrompt = `The user has a LaTeX preamble with the following content:\n\n${preamble}\n\nThe user wants to make the following changes: "${cleanedPrompt}".\n\nPlease provide the full, updated LaTeX code for the preamble section.`;
        } else {
            targetUpdater = setContent;
            systemInstruction = "You are a helpful LaTeX editor assistant. You will be given the user's current LaTeX content and a prompt describing changes. Your task is to return the complete, modified LaTeX content. ONLY output the raw LaTeX code, without any markdown, explanations, or ```latex formatting.";
            fullPrompt = `The user has a LaTeX document with the following content:\n\n${content}\n\nThe user wants to make the following changes: "${aiPrompt}".\n\nPlease provide the full, updated LaTeX code for the content section.`;
        }

        // Clear the target editor to prepare for the streaming response
        targetUpdater('');

        const stream = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: fullPrompt,
            config: {
                systemInstruction: systemInstruction,
            },
        });

        let generatedText = '';
        for await (const chunk of stream) {
            const chunkText = chunk.text;
            if (chunkText) {
                generatedText += chunkText;
                // Use functional updates to correctly append chunks of the stream
                targetUpdater(prev => prev + chunkText);
            }
        }
        
        if (generatedText.trim()) {
            setAiPrompt(''); // Clear prompt on success
        } else {
            setAiError("The AI returned an empty response. Please try rephrasing your prompt.");
        }

    } catch (error) {
        console.error("AI generation failed:", error);
        setAiError("Failed to get a response from the AI. Please check your connection and try again.");
    } finally {
        setIsGenerating(false);
    }
  };

  const acceptAiSuggestion = useCallback(() => {
    if (!aiSuggestion || !aiPromptRef.current) return;

    const { value, selectionStart } = aiPromptRef.current;
    
    // Find the start of the word the user is typing
    let startIndex = selectionStart - 1;
    while(startIndex >= 0 && !/\s/.test(value[startIndex])) {
        startIndex--;
    }
    startIndex++; // move after the space or to the start of string

    const prefix = value.substring(0, startIndex);
    const suffix = value.substring(selectionStart);
    const newPrompt = `${prefix}${aiSuggestion} ${suffix}`;

    setAiPrompt(newPrompt);
    setAiSuggestion(null);

    // After state update, focus and set cursor position
    setTimeout(() => {
        if (aiPromptRef.current) {
            const newCursorPos = (prefix + aiSuggestion + ' ').length;
            aiPromptRef.current.focus();
            aiPromptRef.current.selectionStart = newCursorPos;
            aiPromptRef.current.selectionEnd = newCursorPos;
        }
    }, 0);
  }, [aiSuggestion]);

  const handleAiPromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setAiPrompt(value);

    const cursorPosition = e.target.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPosition);
    const currentWordMatch = textBeforeCursor.match(/@\S*$/);
    const currentWord = currentWordMatch ? currentWordMatch[0] : '';
    
    if (currentWord && '@preamble'.startsWith(currentWord)) {
        setAiSuggestion('@preamble');
    } else {
        setAiSuggestion(null);
    }
  };

  const handleAiPromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (aiSuggestion && (e.key === 'Tab' || e.key === 'Enter')) {
        e.preventDefault();
        acceptAiSuggestion();
        return;
    }
    
    if (e.key === 'Escape') {
      setAiSuggestion(null);
    }

    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSendToAI();
    }
  };


  const handleResize = (clientX) => {
    const newWidth = (clientX / window.innerWidth) * 100;
    if (newWidth > 20 && newWidth < 80) { // Set min/max width
      setLeftPanelWidth(newWidth);
    }
  };

  const handleSync = useCallback((pos: {start: number; end: number}) => {
    if (!contentEditorInstance) return;
    
    const doc = contentEditorInstance.getDoc();
    const from = doc.posFromIndex(pos.start);
    const to = doc.posFromIndex(pos.end);

    if (from && to) {
        contentEditorInstance.focus();
        doc.setSelection(from, to);
        contentEditorInstance.scrollIntoView({ from, to }, 100);
    }
  }, [contentEditorInstance]);
  
  useEffect(() => {
    if (autoCompile) {
      const handler = setTimeout(() => { setDebouncedContent(content); }, 300);
      return () => { clearTimeout(handler); };
    }
  }, [content, autoCompile]);

  const handleManualCompile = () => {
    setDebouncedContent(content);
  };

  const handleDownload = () => {
    const hasDocumentCommands = content.includes('\\title{') || content.includes('\\author{') || content.includes('\\date{');
    const documentContent = hasDocumentCommands 
      ? `${preamble}\n\\begin{document}\n\\maketitle\n${content}\n\\end{document}`
      : `${preamble}\n\\begin{document}\n${content}\n\\end{document}`;
    const blob = new Blob([documentContent], { type: 'text/x-tex' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'document.tex';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleClearContent = () => {
    setContent('');
    if (contentEditorInstance) {
      contentEditorInstance.focus();
    }
  };

  const handleToolbarItemClick = (item) => {
    const addPackage = (pkg: string) => {
      if (!preamble.includes(`\\usepackage{${pkg}}`)) {
        const lines = preamble.split('\n');
        let insertIndex = lines.findIndex(line => line.startsWith('\\documentclass'));
        
        const lastUsepackageIndex = lines.map((line, index) => ({ line, index }))
          .filter(item => item.line.startsWith('\\usepackage'))
          .pop()?.index;

        if (lastUsepackageIndex !== undefined) {
          insertIndex = lastUsepackageIndex;
        }

        const newPreamble = [
          ...lines.slice(0, insertIndex + 1),
          `\\usepackage{${pkg}}`,
          ...lines.slice(insertIndex + 1)
        ].join('\n');
        
        setPreamble(newPreamble);
      }
    };
    
    if (item.code === '\\sout{') {
      addPackage('ulem');
    }
    if (item.code?.includes('\\href')) {
      addPackage('hyperref');
    }
  };
  
  const handleCreateTable = (rows: number, cols: number) => {
    const latexCode = generateTableLatex(rows, cols);
    if (contentEditorInstance) {
      contentEditorInstance.getDoc().replaceSelection(latexCode);
      contentEditorInstance.focus();
    }
    setTableModalOpen(false);
  };

  return (
    <div className="app">
      {isTableModalOpen && <TableCreatorModal onClose={() => setTableModalOpen(false)} onCreate={handleCreateTable} />}
      <div id="left" style={{ width: `${leftPanelWidth}%` }}>
         <div className="main-actions">
          <button onClick={handleDownload} className="action-btn download-btn">
            Download as .tex
          </button>
          <button onClick={handleClearContent} className="action-btn clear-btn">
            Clear Content
          </button>
           <div className="compile-controls">
             <label>
               <input 
                 type="checkbox" 
                 checked={autoCompile} 
                 onChange={(e) => setAutoCompile(e.target.checked)} 
               />
               Auto-compile
             </label>
             {!autoCompile && (
               <button onClick={handleManualCompile} className="action-btn compile-btn">
                 Compile
               </button>
             )}
           </div>
        </div>
        <Toolbar editorInstance={contentEditorInstance} onItemClick={handleToolbarItemClick} onTableClick={() => setTableModalOpen(true)} />
        <div className="editor-section" style={{ flex: 0.5 }}>
          <h3>Preamble</h3>
          <p className="preamble-note">
            Start typing <code>\\usepackage...</code> or <code>\\documentclass...</code> to see suggestions.
          </p>
          <div id="editor-preamble-wrap">
            <Editor 
              value={preamble} 
              onChange={setPreamble} 
              options={{
                hintOptions: { hint: latexHint }
              }}
            />
          </div>
        </div>
        <div className="editor-section" style={{ flex: 1.5 }}>
          <h3>Content</h3>
            {content.includes('\\title{') && (
            <p className="document-note">
              Note: <code>\\maketitle</code> will be added to the downloaded file.
            </p>
          )}
          <div id="editor-content-wrap">
            <Editor 
              value={content} 
              onChange={setContent} 
              setInstance={setContentEditorInstance}
              options={{
                hintOptions: { hint: latexHint }
              }}
            />
          </div>
           <div className="ai-assistant-section">
                <div className="ai-prompt-container">
                    {aiSuggestion && (
                        <div className="ai-suggestion-popup">
                            <button onClick={acceptAiSuggestion}>
                                {aiSuggestion}
                                <small>
                                    <kbd>Tab</kbd> or <kbd>Enter</kbd>
                                </small>
                            </button>
                        </div>
                    )}
                    <textarea
                        ref={aiPromptRef}
                        className="ai-prompt-input"
                        placeholder="Describe changes... Use '@preamble' to edit the preamble. (Ctrl+Enter to send)"
                        value={aiPrompt}
                        onChange={handleAiPromptChange}
                        onKeyDown={handleAiPromptKeyDown}
                        disabled={isGenerating}
                        aria-label="AI Assistant Prompt"
                    />
                    <button
                        className="ai-send-btn"
                        onClick={handleSendToAI}
                        disabled={isGenerating || !aiPrompt.trim()}
                        aria-label={isGenerating ? 'Generating response' : 'Send to AI'}
                    >
                        {isGenerating ? <div className="spinner" /> : '➤'}
                    </button>
                </div>
                {aiError && <div className="ai-error" role="alert">{aiError}</div>}
            </div>
        </div>
      </div>
      <Resizer onDrag={handleResize} />
      <Preview content={debouncedContent} onSyncClick={handleSync} />
    </div>
  );
};

export default App;