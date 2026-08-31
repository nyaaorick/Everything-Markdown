// Returned as the final evaluation result of the injected script (needs to be structured cloneable, hence returns a string)
(() => {
  const clean = (s) => (s || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  /** Determine if an element is truly visible on the page, filtering inactive draft and history edit containers */
  function isElementVisible(el) {
    if (!el) return false;

    // Basic size check
    if (el.offsetWidth === 0 && el.offsetHeight === 0) {
      if (el.getClientRects().length === 0) return false;
    }

    // Computed style check
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    // Recursively check visibility of all parent nodes
    let parent = el.parentElement;
    while (parent) {
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') return false;
      parent = parent.parentElement;
    }
    return true;
  }

  /** Checks if it looks like a "User Bubble" root node (Gemini often changes class names, keeping multiple fallbacks) */
  function isUserRoot(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "user-query") return true;
    if (el.classList?.contains("user-query-container")) return true;
    if (el.hasAttribute?.("data-is-user")) return true;
    const role = el.getAttribute?.("data-turn-role") || el.getAttribute?.("data-message-author");
    if (role && role.toLowerCase() === "user") return true;
    return false;
  }

  /** Parses HTML tables and converts them to standard Markdown table format */
  function parseTable(tableNode, indent) {
    const rows = tableNode.querySelectorAll('tr');
    if (rows.length === 0) return "";

    let mdTable = "\n";
    let hasHeader = false;
    let colCount = 0;

    rows.forEach((row, rowIndex) => {
      // Only select direct child cells to avoid confusion in nested table parsing
      const cells = Array.from(row.children).filter(
        child => child.tagName === 'TH' || child.tagName === 'TD'
      );
      if (cells.length === 0) return;

      if (rowIndex === 0) {
        colCount = cells.length;
        hasHeader = cells.every(cell => cell.tagName === 'TH') || row.parentElement?.tagName === 'THEAD';
      }

      let rowContent = "| ";
      cells.forEach(cell => {
        // Parse the HTML inside the cell, converting internal newlines to <br> to prevent breaking Markdown table structure
        const cellText = recursiveParse(cell, indent).trim().replace(/\r?\n/g, "<br>");
        rowContent += cellText + " | ";
      });

      mdTable += rowContent + "\n";

      // If the first row is a header, add the Markdown divider
      if (rowIndex === 0 && colCount > 0) {
        let divider = "|";
        for (let i = 0; i < colCount; i++) {
          divider += " --- |";
        }
        mdTable += divider + "\n";
      }
    });

    return mdTable + "\n";
  }

  /** Recursively parse DOM tree nodes into high-quality Markdown */
  function recursiveParse(node, indent = "", listContext = null) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    // Filter assistive technology elements or explicitly hidden decorative elements
    if (node.getAttribute('aria-hidden') === 'true' || node.classList?.contains('sr-only')) {
      return "";
    }

    // Filter superfluous interactive components in conversations (e.g., copy code buttons, feedback bars, etc.)
    if (node.classList?.contains('code-block-header') ||
        node.classList?.contains('code-block-decorator') ||
        node.tagName === 'BUTTON' ||
        node.tagName === 'SVG' ||
        node.getAttribute('role') === 'button') {
      return "";
    }

    // Perfectly handle KaTeX math formulas, extracting clean LaTeX source code
    if (node.classList?.contains('katex')) {
      const annot = node.querySelector('annotation[encoding="application/x-tex"]');
      if (annot) {
        const latex = annot.textContent.trim();
        // Distinguish between inline and block formulas
        const isBlock = node.classList.contains('katex-display') ||
                        node.parentElement?.classList.contains('katex-display');
        if (isBlock) {
          return `\n\n$$\n${latex}\n$$\n\n`;
        } else {
          return ` $${latex}$ `;
        }
      }
    }

    const tag = node.tagName.toLowerCase();

    switch (tag) {
      case 'h1': return `\n\n# ${recursiveChildren(node, indent, listContext)}\n\n`;
      case 'h2': return `\n\n## ${recursiveChildren(node, indent, listContext)}\n\n`;
      case 'h3': return `\n\n### ${recursiveChildren(node, indent, listContext)}\n\n`;
      case 'h4': return `\n\n#### ${recursiveChildren(node, indent, listContext)}\n\n`;
      case 'h5': return `\n\n##### ${recursiveChildren(node, indent, listContext)}\n\n`;
      case 'h6': return `\n\n###### ${recursiveChildren(node, indent, listContext)}\n\n`;

      case 'p': {
        const content = recursiveChildren(node, indent, listContext).trim();
        return content ? `\n\n${content}\n\n` : "";
      }

      case 'strong':
      case 'b': {
        const content = recursiveChildren(node, indent, listContext);
        return content.trim() ? `**${content}**` : "";
      }

      case 'em':
      case 'i': {
        const content = recursiveChildren(node, indent, listContext);
        return content.trim() ? `*${content}*` : "";
      }

      case 'br': return "\n";

      case 'a': {
        const content = recursiveChildren(node, indent, listContext);
        const href = node.getAttribute('href');
        return content.trim() && href ? `[${content}](${href})` : content;
      }

      case 'code': {
        const isBlock = node.closest('pre') !== null;
        if (isBlock) {
          return node.textContent; // Code block is uniformly handled by pre wrapping
        } else {
          return ` \`${node.textContent.trim()}\` `;
        }
      }

      case 'pre': {
        const codeNode = node.querySelector('code');
        const codeText = codeNode ? codeNode.textContent : node.textContent;

        // Auto-parse programming language type of code block
        let lang = "";
        const classAttr = codeNode?.getAttribute('class') || node.getAttribute('class') || "";
        const match = classAttr.match(/lang(?:uage)?-(\w+)/);
        if (match) {
          lang = match[1];
        }

        return `\n\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n\n`;
      }

      case 'table': {
        return parseTable(node, indent);
      }

      case 'ul': {
        let result = "\n";
        let liIndex = 1;
        Array.from(node.children).forEach(child => {
          if (child.tagName.toLowerCase() === 'li') {
            result += recursiveParse(child, indent, { type: 'ul', index: liIndex++ });
          }
        });
        return result + "\n";
      }

      case 'ol': {
        let result = "\n";
        let liIndex = 1;
        Array.from(node.children).forEach(child => {
          if (child.tagName.toLowerCase() === 'li') {
            result += recursiveParse(child, indent, { type: 'ol', index: liIndex++ });
          }
        });
        return result + "\n";
      }

      case 'li': {
        const prefix = listContext?.type === 'ol' ? `${listContext.index}. ` : "* ";

        // Separate body child nodes and nested sub-lists
        let textParts = [];
        let subListParts = [];

        Array.from(node.childNodes).forEach(child => {
          const childTag = child.nodeType === Node.ELEMENT_NODE ? child.tagName.toLowerCase() : "";
          if (childTag === 'ul' || childTag === 'ol') {
            subListParts.push(child);
          } else {
            textParts.push(child);
          }
        });

        let textContent = "";
        textParts.forEach(part => {
          textContent += recursiveParse(part, indent, listContext);
        });
        textContent = textContent.trim();

        let result = `${indent}${prefix}${textContent}\n`;

        // Recursively handle sub-lists and increase indentation width to comply with Markdown specs
        subListParts.forEach(subList => {
          result += recursiveParse(subList, indent + "  ", listContext);
        });

        return result;
      }

      default: {
        return recursiveChildren(node, indent, listContext);
      }
    }
  }

  function recursiveChildren(node, indent, listContext) {
    let result = "";
    node.childNodes.forEach(child => {
      result += recursiveParse(child, indent, listContext);
    });
    return result;
  }

  /** Drop the separator trailing the final turn so the export does not end on a stray rule */
  function trimTrailingRule(md) {
    return md.replace(/\n---\n\n$/, "\n");
  }

  /** If message-content-container exists, use it as a fallback when main merge strategy yields no result */
  function exportFromTurnContainers() {
    const roots = Array.from(document.querySelectorAll("message-content-container"))
                       .filter(isElementVisible);
    if (!roots.length) return null;

    let md = "# Gemini Conversation Export\n\n";
    roots.forEach((node, index) => {
      const userByAttr =
        node.hasAttribute("data-is-user") ||
        node.getAttribute("data-turn-role") === "user" ||
        node.getAttribute("data-message-author") === "user";
      const userByDom =
        !!node.querySelector("user-query, .user-query-container") &&
        !node.querySelector("message-content");
      const isUser = userByAttr || userByDom || isUserRoot(node);

      const label = isUser ? "User" : "Gemini";
      const text = clean(recursiveParse(node));
      if (!text) return;
      md += `### ${index + 1} · ${label}\n\n${text}\n\n---\n\n`;
    });
    return trimTrailingRule(md);
  }

  function pickRoleLabel(node) {
    const isUser =
      isUserRoot(node) ||
      node.tagName?.toLowerCase() === "user-query" ||
      !!node.closest?.(".user-query-container");
    return { isUser, label: isUser ? "User" : "Gemini" };
  }

  /** Remove nodes that are strictly contained within other candidate nodes, to avoid exporting outer container and inner user-query twice */
  function dropStrictlyContained(picks) {
    return picks.filter(
      (node) => !picks.some((other) => other !== node && other.contains(node))
    );
  }

  /** Remove adjacent duplicate text blocks of the same role */
  function dropConsecutiveDuplicateText(picks) {
    const out = [];
    let prevKey = null;
    for (const node of picks) {
      const { isUser } = pickRoleLabel(node);
      const text = clean(recursiveParse(node));
      if (!text) continue;
      const key = `${isUser ? "u" : "m"}\n${text}`;
      if (key === prevKey) continue;
      prevKey = key;
      out.push(node);
    }
    return out;
  }

  /** Main export strategy: search for user queries and message-content separately, and precisely merge by DOM document order */
  function exportMergedByDocumentOrder() {
    const seen = new Set();
    const picks = [];

    const tryAdd = (el) => {
      if (!el || seen.has(el) || !isElementVisible(el)) return;
      seen.add(el);
      picks.push(el);
    };

    // Collect only visible User nodes to avoid pollution from old edited versions
    document.querySelectorAll(".user-query-container").forEach((el) => {
      if (el.parentElement?.closest?.(".user-query-container")) return;
      if (el.querySelector("user-query")) return;
      tryAdd(el);
    });
    document.querySelectorAll("user-query").forEach((el) => tryAdd(el));

    // Collect only visible Gemini response nodes to avoid pollution from inactive drafts
    document.querySelectorAll("message-content").forEach((el) => {
      if (el.closest("user-query, .user-query-container")) return;
      tryAdd(el);
    });

    if (!picks.length) return null;

    // Sort by DOM document physical flow order
    picks.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const filtered = dropConsecutiveDuplicateText(dropStrictlyContained(picks));

    let md = "# Gemini Conversation Export\n\n";
    let serial = 0;
    filtered.forEach((node) => {
      const { label } = pickRoleLabel(node);
      const text = clean(recursiveParse(node));
      if (!text) return;
      serial += 1;
      md += `### ${serial} · ${label}\n\n${text}\n\n---\n\n`;
    });
    return trimTrailingRule(md);
  }

  // First choice: merge currently visible "Question + Answer"
  const merged = exportMergedByDocumentOrder();
  if (merged) return merged;

  // Fallback: export conversation from Turn containers
  const fromTurns = exportFromTurnContainers();
  if (fromTurns) return fromTurns;

  return (
    "# Gemini conversation nodes not recognized\n\n" +
    "Please use F12 on the conversation page to inspect an outer tag of 'Your question', and send the selector to the author to update.\n\n" +
    "Preview of the first 500 words of the current page:\n\n" +
    clean(document.body?.innerText || "").slice(0, 500)
  );
})();
